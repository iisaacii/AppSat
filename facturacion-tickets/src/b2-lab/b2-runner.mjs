import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { getPortalArtifactsDir } from "../config/env.mjs";
import { selectBestOption } from "../shared/playwright-select-control.mjs";
import { tryAutoDownloadB2Cfdi } from "./b2-downloads.mjs";
import { readB2LearningNotes, saveB2FieldMappingNotes } from "./b2-learning-notes.mjs";
import {
  buildB2RepairActions,
  classifyB2PageState,
  classifyB2PortalBlocker,
  inferB2FlowState,
  validateB2FieldValues,
} from "./b2-semantic-validation.mjs";
import { generateB2DiagnosticPlan, generateB2FieldPlan } from "./gemini-field-mapper.mjs";
import { extractVisiblePageState } from "./page-state-extractor.mjs";
import { rescuePortalUrl } from "../portal-discovery/portal-url-rescue.service.mjs";

const finalTextPattern = /facturar|generar\s+factura|emitir|timbrar|finalizar/i;
const defaultRecoveryAttempts = 4;

export async function runB2Lab({ job, extracted, taxProfile, fiscalCompliance, portalUrl, maxTurns = 8 }) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== "false" });
  const page = await browser.newPage({ acceptDownloads: true });
  const trace = {
    providerMode: "b2_field_mapper",
    startedAt: new Date().toISOString(),
    turns: [],
    executedActions: [],
    failedActions: [],
    flowStates: [],
    portalUrlRescue: null,
  };
  const ticket = buildTicketDictionary(extracted);
  const previousErrors = [];
  const oneShotActions = new Set();
  const recoveryAttempts = [];
  const maxRecoveryAttempts = Number(process.env.B2_MAX_RECOVERY_ATTEMPTS ?? defaultRecoveryAttempts);
  const allowFinalSubmit = process.env.B2_ALLOW_FINAL_SUBMIT !== "false";
  const learningNotes = await readB2LearningNotes(portalUrl);
  let flowState = "filling_ticket";
  let b2DownloadResult = null;
  let lastValidation = null;

  try {
    const openedUrl = await gotoB2PortalWithRescue({
      browser,
      page,
      portalUrl,
      job,
      extracted,
      trace,
    });
    portalUrl = openedUrl;
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      const pageState = await extractB2PageState(page);
      const readiness = inspectFinalSubmitReadiness(pageState);
      const requiredStatus = inspectRequiredFieldStatus(pageState);
      const blocker = classifyB2PortalBlocker(pageState);
      const validation = validateB2FieldValues(pageState, { ticket, taxProfile, fiscalCompliance });
      lastValidation = validation;
      flowState = inferB2FlowState(pageState, { readiness, blocker, downloads: b2DownloadResult });
      trace.flowStates.push({ turn, flowState, url: pageState.url });

      if (blocker.blocked) {
          const artifacts = await captureB2Artifacts(page, { id: job.id, prefix: "b2-blocked" });
          return buildResult({
            status: "needs_user_action",
            reason: blocker.reason,
            statusMessage: blocker.statusMessage,
            trace,
            artifacts,
            pageState,
            readiness,
            flowState: "blocked",
            validation,
            recoveryAttempts,
            downloadResult: b2DownloadResult,
          });
      }

      b2DownloadResult = await tryAutoDownloadB2Cfdi(page, { job }).catch((error) => {
        previousErrors.push(`download_attempt_failed: ${error.message}`);
        return null;
      });

      if (b2DownloadResult?.xmlPath && b2DownloadResult?.pdfPath) {
        const artifacts = await captureB2Artifacts(page, { id: job.id, prefix: "b2-completed" });
        return buildResult({
          status: "completed",
          reason: "b2_cfdi_downloaded",
          statusMessage: "B2 emitio y descargo XML/PDF",
          trace,
          artifacts,
          pageState,
          readiness,
          flowState: "completed",
          validation,
          recoveryAttempts,
          downloadResult: b2DownloadResult,
        });
      }

      if (readiness.ready && hasB2SubmitEvidence(validation, requiredStatus)) {
        if (!validation.ok) {
          const recovered = await recoverB2Flow({
            page,
            trigger: "semantic_mismatch_before_submit",
            pageState,
            validation,
            failedActions: [],
            ticket,
            taxProfile,
            fiscalCompliance,
            flowState,
            learningNotes,
            previousErrors,
            recoveryAttempts,
            maxRecoveryAttempts,
            portalUrl,
          });

          if (recovered) {
            continue;
          }
        } else if (allowFinalSubmit) {
          try {
            const finalAction = await clickB2FinalSubmit(page, readiness);
            trace.executedActions.push(finalAction);
            flowState = "submitting_invoice";
            await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
            await page.waitForTimeout(1500);
            continue;
          } catch (error) {
            previousErrors.push(`final_submit_failed: ${error.message}`);
            const recovered = await recoverB2Flow({
              page,
              trigger: "final_submit_failed",
              pageState,
              validation,
              failedActions: [{ type: "finalSubmit", selector: readiness.controls?.[0]?.selector, error: error.message }],
              ticket,
              taxProfile,
              fiscalCompliance,
              flowState,
              learningNotes,
              previousErrors,
              recoveryAttempts,
              maxRecoveryAttempts,
              portalUrl,
            });

            if (recovered) {
              continue;
            }
          }
        } else {
          const artifacts = await captureB2Artifacts(page, { id: job.id, prefix: "b2-ready" });
          return buildResult({
            status: "needs_user_action",
            reason: "b2_pre_submit_ready",
            statusMessage: "B2 dejo el portal listo para emitir pero B2_ALLOW_FINAL_SUBMIT=false",
            trace,
            artifacts,
            pageState,
            readiness,
            flowState: "preview_or_confirm",
            validation,
            recoveryAttempts,
            downloadResult: b2DownloadResult,
          });
        }
      }

      const autoAdvance = await tryAutoAdvanceSafeStep(page, pageState);
      if (autoAdvance) {
        trace.executedActions.push(autoAdvance);
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(800);
        continue;
      }

      const autoCloseModal = await tryAutoCloseInformationalModal(page, pageState);
      if (autoCloseModal) {
        trace.executedActions.push(autoCloseModal);
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(500);
        continue;
      }

      const autoSaveEmail = await tryAutoSaveEmail(page, pageState, oneShotActions);
      if (autoSaveEmail) {
        trace.executedActions.push(autoSaveEmail);
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(800);
        continue;
      }

      const plan = await generateB2FieldPlan({
        pageState: trimPageState(pageState),
        ticket,
        taxProfile,
        fiscalCompliance,
        goal: "Advance toward automatic CFDI generation and XML/PDF download. Do not click final invoice submit; the runner does that after semantic validation.",
        attempt: turn,
        previousErrors,
        flowState,
        learningNotes,
      });
      const turnRecord = {
        turn,
        url: pageState.url,
        flowState,
        readiness,
        requiredStatus,
        validation,
        plan,
      };
      trace.turns.push(turnRecord);

      if (plan.status === "ready_for_final_submit") {
        const latest = await extractB2PageState(page);
        const latestReadiness = inspectFinalSubmitReadiness(latest);
        const latestValidation = validateB2FieldValues(latest, { ticket, taxProfile, fiscalCompliance });
        if (
          latestReadiness.ready &&
          hasB2SubmitEvidence(latestValidation, requiredStatus) &&
          allowFinalSubmit
        ) {
          try {
            const finalAction = await clickB2FinalSubmit(page, latestReadiness);
            trace.executedActions.push(finalAction);
            await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
            await page.waitForTimeout(1500);
            continue;
          } catch (error) {
            previousErrors.push(`final_submit_failed: ${error.message}`);
          }
        }
      }

      if (["cannot_solve", "blocked"].includes(plan.status) || !plan.actions.length) {
        previousErrors.push(plan.reason);
        break;
      }

      const execution = await executeB2Actions(page, plan.actions, { ticket, taxProfile, fiscalCompliance, job });
      trace.executedActions.push(...execution.executed);
      trace.failedActions.push(...execution.failed);
      if (execution.downloads) {
        b2DownloadResult = execution.downloads;
      }

      if (execution.failed.length) {
        previousErrors.push(...execution.failed.map((item) => item.error));
        await recoverB2Flow({
          page,
          trigger: "action_failed",
          pageState: await extractB2PageState(page),
          validation: { ok: true, issues: [] },
          failedActions: execution.failed,
          ticket,
          taxProfile,
          fiscalCompliance,
          flowState,
          learningNotes,
          previousErrors,
          recoveryAttempts,
          maxRecoveryAttempts,
          portalUrl,
        });
      }

      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(800);
    }

    const pageState = await extractB2PageState(page);
    const artifacts = await captureB2Artifacts(page, { id: job.id, prefix: "b2-incomplete" });

    return buildResult({
      status: "needs_user_action",
      reason: "b2_learning_incomplete",
      statusMessage: "B2 no logro llegar al boton final habilitado",
      trace,
      artifacts,
      pageState,
      readiness: inspectFinalSubmitReadiness(pageState),
      flowState,
      validation: lastValidation,
      recoveryAttempts,
      downloadResult: b2DownloadResult,
    });
  } finally {
    await browser.close();
  }
}

async function gotoB2PortalWithRescue({ browser, page, portalUrl, job, extracted, trace }) {
  try {
    await page.goto(portalUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    return portalUrl;
  } catch (error) {
    const rescue = await rescuePortalUrl({
      browser,
      failedUrl: portalUrl,
      job,
      extracted,
      timeoutMs: 12000,
    });
    trace.portalUrlRescue = {
      failedUrl: portalUrl,
      error: error.message,
      ...rescue,
    };

    if (!rescue.selectedUrl) {
      throw new Error(
        `B2 portal URL failed and Gemini/Search rescue did not resolve a candidate. Original error: ${error.message}. Rescue: ${JSON.stringify(rescue)}`,
      );
    }

    await page.goto(rescue.selectedUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    return rescue.selectedUrl;
  }
}

async function extractB2PageState(page) {
  const pageState = await extractVisiblePageState(page);
  return {
    ...pageState,
    pageClassification: classifyB2PageState(pageState),
  };
}

async function executeB2Actions(page, actions, valueSource) {
  const executed = [];
  const failed = [];
  let downloads = null;

  for (const action of actions) {
    try {
      validateAction(action);
      if (["fill", "setValue", "datePicker"].includes(action.type)) {
        await fillB2Control(page, action, valueSource);
      } else if (action.type === "select") {
        const locator = await resolveVisibleLocator(page, action.selector, { enabled: true });
        await selectBestOption(page, locator, readValue(action, valueSource), action);
      } else if (action.type === "click") {
        const preflight = await runB2PreClickValidation(page, action, valueSource);
        executed.push(...preflight.executed);

        if (preflight.failed.length) {
          failed.push(...preflight.failed);
          break;
        }

        await clickB2Control(page, action);
      } else if (action.type === "downloadCfdi") {
        downloads = await tryAutoDownloadB2Cfdi(page, { job: valueSource.job });
      } else if (action.type === "stop") {
        break;
      }

      executed.push({
        type: action.type,
        selector: action.selector ?? null,
        valueKey: action.valueKey ?? null,
        reason: action.reason ?? null,
      });
      await page.waitForTimeout(500);
    } catch (error) {
      failed.push({
        type: action.type,
        selector: action.selector ?? null,
        valueKey: action.valueKey ?? null,
        reason: action.reason ?? null,
        error: error.message,
      });
      break;
    }
  }

  return { executed, failed, downloads };
}

async function runB2PreClickValidation(page, action, valueSource) {
  const executed = [];
  const failed = [];
  const scope = inferPreClickValidationScope(action);

  if (!scope) {
    return { executed, failed };
  }

  const pageState = await extractB2PageState(page);
  const targetButton = (pageState.buttons ?? []).find((button) => button.selector === action.selector);

  if (!targetButton || targetButton.enabled === false) {
    return { executed, failed };
  }

  const validation = validateB2FieldValues(pageState, {
    ticket: valueSource.ticket,
    taxProfile: valueSource.taxProfile,
    fiscalCompliance: valueSource.fiscalCompliance,
    includeEmptyIssues: true,
    scope,
  });
  const repairActions = buildB2RepairActions(validation.issues);

  for (const repairAction of repairActions) {
    try {
      validateAction(repairAction);
      if (["fill", "setValue", "datePicker"].includes(repairAction.type)) {
        await fillB2Control(page, repairAction, valueSource);
      } else if (repairAction.type === "select") {
        const locator = await resolveVisibleLocator(page, repairAction.selector, { enabled: true });
        await selectBestOption(page, locator, readValue(repairAction, valueSource), repairAction);
      }

      executed.push({
        type: repairAction.type,
        selector: repairAction.selector ?? null,
        valueKey: repairAction.valueKey ?? null,
        reason: `pre_click_${scope}:${repairAction.reason ?? "repair"}`,
      });
      await page.waitForTimeout(250);
    } catch (error) {
      failed.push({
        type: repairAction.type,
        selector: repairAction.selector ?? null,
        valueKey: repairAction.valueKey ?? null,
        reason: `pre_click_${scope}:${repairAction.reason ?? "repair"}`,
        error: error.message,
      });
      break;
    }
  }

  return { executed, failed };
}

function inferPreClickValidationScope(action) {
  const probe = `${action.selector ?? ""} ${action.reason ?? ""}`;

  if (/validar.*ticket|validarticket|verificar|buscar.*ticket|consultar.*ticket/i.test(probe)) {
    return "ticket";
  }

  if (/continuar|previsualiza|preview|buscar|consultar/i.test(probe)) {
    return "taxProfile";
  }

  return null;
}

async function recoverB2Flow({
  page,
  trigger,
  pageState,
  validation,
  failedActions,
  ticket,
  taxProfile,
  fiscalCompliance,
  flowState,
  learningNotes,
  previousErrors,
  recoveryAttempts,
  maxRecoveryAttempts,
  portalUrl,
}) {
  if (recoveryAttempts.length >= maxRecoveryAttempts) {
    previousErrors.push(`B2 recovery attempts exhausted for ${trigger}`);
    return false;
  }

  const validationIssues = validation?.issues ?? [];
  const deterministicActions = buildB2RepairActions(validationIssues);
  const attempt = {
    index: recoveryAttempts.length + 1,
    trigger,
    flowState,
    startedAt: new Date().toISOString(),
    validationIssues,
    failedActions,
    diagnosticPlan: null,
    repairActions: [],
    status: "pending",
  };

  const diagnosticPlan = await generateB2DiagnosticPlan({
    pageState: trimPageState(pageState),
    ticket,
    taxProfile,
    fiscalCompliance,
    goal: "Diagnose why B2 is blocked and return a minimal repair plan using safe JSON actions.",
    attempt: attempt.index,
    previousErrors,
    flowState,
    validationIssues,
    failedActions,
    learningNotes,
  });

  attempt.diagnosticPlan = diagnosticPlan;
  attempt.repairActions = deterministicActions.length ? deterministicActions : diagnosticPlan.actions ?? [];

  if (!attempt.repairActions.length) {
    attempt.status = "no_repair_actions";
    recoveryAttempts.push(attempt);
    previousErrors.push(diagnosticPlan.reason ?? `No repair action for ${trigger}`);
    return false;
  }

  const execution = await executeB2Actions(page, attempt.repairActions, { ticket, taxProfile, fiscalCompliance });
  attempt.executedActions = execution.executed;
  attempt.failedActionsAfterRepair = execution.failed;
  attempt.status = execution.failed.length ? "failed" : "repaired";
  recoveryAttempts.push(attempt);

  if (validationIssues.length && !execution.failed.length) {
    const nextNotes = await saveB2FieldMappingNotes(portalUrl, validationIssues).catch(() => null);
    if (nextNotes) {
      learningNotes.fieldMappings = nextNotes.fieldMappings;
      learningNotes.updatedAt = nextNotes.updatedAt;
    }
  }

  if (execution.failed.length) {
    previousErrors.push(...execution.failed.map((item) => item.error));
    return false;
  }

  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(800);
  return true;
}

async function clickB2FinalSubmit(page, readiness) {
  const control = readiness.controls.find((item) => item.enabled) ?? readiness.controls[0];

  if (!control?.selector) {
    throw new Error("No final submit control available");
  }

  const locator = await resolveVisibleLocator(page, control.selector, { enabled: true });
  await locator.click({ timeout: 15000 });

  return {
    type: "finalSubmit",
    selector: control.selector,
    valueKey: null,
    reason: "b2_auto_final_submit_after_semantic_validation",
  };
}

async function clickB2Control(page, action) {
  const locator = await resolveVisibleLocator(page, action.selector, { enabled: true });
  const href = await locator
    .evaluate((element) => {
      if (element instanceof HTMLAnchorElement && element.href && element.href !== "#") {
        return element.href;
      }

      return null;
    })
    .catch(() => null);

  if (href && shouldNavigateHrefDirectly(href, page.url())) {
    await page.goto(href, { waitUntil: "domcontentloaded", timeout: 45000 });
    return;
  }

  const popupPromise = page.waitForEvent("popup", { timeout: 3000 }).catch(() => null);
  await locator.click({ timeout: 12000 });
  const popup = await popupPromise;

  if (popup) {
    await popup.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    const popupUrl = popup.url();
    await popup.close().catch(() => {});

    if (popupUrl && popupUrl !== "about:blank") {
      await page.goto(popupUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    }
  }
}

function shouldNavigateHrefDirectly(href, currentUrl) {
  try {
    const next = new URL(href, currentUrl);

    if (!/^https?:$/i.test(next.protocol)) {
      return false;
    }

    return !["#", "javascript:void(0)", "javascript:;"].includes(String(href).trim().toLowerCase());
  } catch {
    return false;
  }
}

async function fillB2Control(page, action, valueSource) {
  const rawValue = readValue(action, valueSource);
  const value = normalizeFillValue(rawValue, action);
  const locator = await resolveVisibleLocator(page, action.selector, { enabled: true });
  const editable = await locator.isEditable().catch(() => false);

  if (editable) {
    await locator.fill(value, { timeout: 12000 });
    return;
  }

  await locator.evaluate((element, nextValue) => {
    if (!("value" in element)) {
      throw new Error("Element does not support value assignment.");
    }

    element.value = nextValue;
    element.setAttribute("value", nextValue);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  }, value);
}

function normalizeFillValue(rawValue, action) {
  const value = String(rawValue ?? "");
  const probe = `${action.selector ?? ""} ${action.reason ?? ""} ${action.valueKey ?? ""}`;

  if (/fecha|date/i.test(probe)) {
    const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) {
      return `${iso[3]}/${iso[2]}/${iso[1]}`;
    }
  }

  return value;
}

async function resolveVisibleLocator(page, selector, { editable = false, enabled = false } = {}) {
  const selectors = buildSelectorFallbacks(selector);

  for (const candidateSelector of selectors) {
    const resolved = await findVisibleLocator(page, candidateSelector, { editable, enabled });

    if (resolved) {
      return resolved;
    }
  }

  return page.locator(selectors[0] ?? selector).first();
}

async function findVisibleLocator(page, selector, { editable = false, enabled = false } = {}) {
  const locator = page.locator(selector);
  const count = await locator.count().catch(() => 0);

  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    const visibleOk = await candidate.isVisible().catch(() => false);
    const enabledOk = !enabled || (await candidate.isEnabled().catch(() => false));
    const editableOk = !editable || (await candidate.isEditable().catch(() => false));

    if (visibleOk && enabledOk && editableOk) {
      return candidate;
    }
  }

  return null;
}

function buildSelectorFallbacks(selector) {
  const raw = String(selector ?? "").trim();
  const fallbacks = [];
  const add = (value) => {
    const normalized = String(value ?? "").trim();
    if (normalized && !fallbacks.includes(normalized)) {
      fallbacks.push(normalized);
    }
  };

  add(raw);

  const hasText = raw.match(/^(a|button)?:?has-text\("([^"]+)"\)$/i) ?? raw.match(/^(a|button):has-text\("([^"]+)"\)$/i);
  const text = extractHasTextArgument(raw);

  if (text) {
    const collapsed = collapseRepeatedText(text);
    const shortText = shortenClickableText(collapsed);

    if (raw.includes(":has-text")) {
      const tag = raw.match(/^([a-z]+):has-text/i)?.[1];
      if (tag) {
        add(`${tag}:has-text("${escapeSelectorText(collapsed)}")`);
        add(`${tag}:has-text("${escapeSelectorText(shortText)}")`);
      }
    }

    add(`a:has-text("${escapeSelectorText(shortText)}")`);
    add(`button:has-text("${escapeSelectorText(shortText)}")`);
    add(`text="${escapeSelectorText(shortText)}"`);
  }

  return fallbacks;
}

function extractHasTextArgument(selector) {
  return String(selector ?? "").match(/:has-text\("([^"]+)"\)/i)?.[1] ?? null;
}

function collapseRepeatedText(value) {
  const words = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  for (let size = 1; size <= Math.floor(words.length / 2); size += 1) {
    if (words.length % size !== 0) {
      continue;
    }

    const unit = words.slice(0, size).join(" ");
    const repeated = [];
    for (let index = 0; index < words.length / size; index += 1) {
      repeated.push(unit);
    }

    if (repeated.join(" ") === words.join(" ")) {
      return unit;
    }
  }

  return words.join(" ");
}

function shortenClickableText(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const useful = text.match(/ir al portal de facturaci[oó]n|portal de facturaci[oó]n|facturaci[oó]n electr[oó]nica|facturar/i)?.[0];
  return useful ?? text.slice(0, 60);
}

function escapeSelectorText(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function tryAutoAdvanceSafeStep(page, pageState) {
  if ((pageState.inputs ?? []).length || (pageState.selects ?? []).length || (pageState.alerts ?? []).length) {
    return null;
  }

  const bodyText = String(pageState.bodyText ?? "");
  const looksLikeReviewStep =
    /verifica|revisa|confirma|validaci[oó]n|datos fiscales|informaci[oó]n fiscal/i.test(bodyText);

  if (!looksLikeReviewStep) {
    return null;
  }

  const button = (pageState.buttons ?? []).find((candidate) => {
    const text = String(candidate.text ?? "").trim();
    return candidate.enabled && /^(siguiente|continuar|aceptar)$/i.test(text) && !candidate.looksFinal;
  });

  if (!button?.selector) {
    return null;
  }

  const locator = await resolveVisibleLocator(page, button.selector, { enabled: true });
  await locator.click({ timeout: 12000 });

  return {
    type: "click",
    selector: button.selector,
    valueKey: null,
    reason: "auto_advance_safe_review_step",
  };
}

async function tryAutoSaveEmail(page, pageState, oneShotActions) {
  if (oneShotActions.has("save_email")) {
    return null;
  }

  const emailInput = (pageState.inputs ?? []).find((input) => {
    const probe = `${input.id ?? ""} ${input.name ?? ""} ${input.label ?? ""} ${input.placeholder ?? ""}`;
    return input.enabled && /correo|email/i.test(probe) && /\S+@\S+\.\S+/.test(String(input.value ?? ""));
  });
  const fiscalSelectsReady =
    (pageState.selects ?? []).filter((select) => {
      const probe = `${select.id ?? ""} ${select.name ?? ""} ${select.label ?? ""}`;
      const value = String(select.value ?? "").trim();
      return /regimen|r[eé]gimen|cfdi|uso/i.test(probe) && value && !/tipo de|uso cfdi|seleccione/i.test(value);
    }).length >= 2;
  const button = (pageState.buttons ?? []).find((candidate) => {
    const text = String(candidate.text ?? "").trim();
    return candidate.enabled && /guardar\s+correo/i.test(text);
  });

  if (!emailInput || !fiscalSelectsReady || !button?.selector) {
    return null;
  }

  oneShotActions.add("save_email");
  const locator = await resolveVisibleLocator(page, button.selector, { enabled: true });
  await locator.click({ timeout: 12000 });

  return {
    type: "click",
    selector: button.selector,
    valueKey: null,
    reason: "auto_save_email_after_fiscal_fields",
  };
}

async function tryAutoCloseInformationalModal(page, pageState) {
  const hasInformationalAlert = (pageState.alerts ?? []).some((alert) =>
    /identifica la informaci[oó]n necesaria|informaci[oó]n necesaria para.*factura|ayuda/i.test(String(alert)),
  );

  if (!hasInformationalAlert) {
    return null;
  }

  const closeLocator = page.locator(
    ".ui-dialog[aria-hidden='false'] .ui-dialog-titlebar-close, [role='dialog'][aria-hidden='false'] .ui-dialog-titlebar-close, .swal2-close, .modal.show [data-dismiss='modal']",
  );
  const count = await closeLocator.count();

  for (let index = 0; index < count; index += 1) {
    const candidate = closeLocator.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click({ timeout: 12000 });
      return {
        type: "click",
        selector: "visible_modal_close",
        valueKey: null,
        reason: "auto_close_informational_modal",
      };
    }
  }

  return null;
}

function validateAction(action) {
  if (!["fill", "setValue", "datePicker", "select", "click", "downloadCfdi", "stop"].includes(action?.type)) {
    throw new Error(`Unsupported B2 action type: ${action?.type}`);
  }

  if (!["stop", "downloadCfdi"].includes(action.type) && !action.selector) {
    throw new Error(`${action.type} requires selector`);
  }

  const probe = `${action.selector ?? ""}`;
  if (action.type === "click" && finalTextPattern.test(probe)) {
    throw new Error("B2 refused unsafe final-looking click");
  }
}

function readValue(action, source) {
  if (action.value !== undefined && action.value !== null) {
    return action.value;
  }

  return String(action.valueKey ?? "")
    .split(".")
    .reduce((current, key) => current?.[key], source);
}

export function buildTicketDictionary(extracted = {}) {
  const candidates = extracted.ocrCandidates ?? {};

  return {
    rfcEmisor: extracted.rfcEmisor ?? candidates.rfc?.[0] ?? null,
    ticketId: candidates.ticketId ?? candidates.idVenta ?? extracted.folio ?? null,
    folio:
      extracted.folio ??
      candidates.folioTicket ??
      candidates.folioVenta ??
      candidates.noTicket ??
      candidates.folio ??
      candidates.ticketId ??
      null,
    folioVenta: candidates.folioVenta ?? candidates.folioTicket ?? candidates.folio ?? extracted.folio ?? null,
    idVenta: candidates.idVenta ?? candidates.ticketId ?? candidates.tc ?? null,
    codigoFacturacion:
      candidates.codigoFacturacion ??
      candidates.codigoFact ??
      candidates.codigoUnico ??
      candidates.codigoUnicoTicket ??
      null,
    codigoFact:
      candidates.codigoFact ??
      candidates.codigoFacturacion ??
      candidates.codigoUnico ??
      candidates.codigoUnicoTicket ??
      null,
    codigoUnico:
      candidates.codigoUnico ??
      candidates.codigoFacturacion ??
      candidates.codigoFact ??
      candidates.codigoUnicoTicket ??
      null,
    orden: candidates.orden ?? candidates.order ?? null,
    tc: candidates.tc ?? candidates.idVenta ?? candidates.ticketId ?? extracted.folio ?? null,
    tr: candidates.tr ?? null,
    sucursal: candidates.sucursal ?? candidates.tda ?? null,
    serie: candidates.serie ?? null,
    token: candidates.token ?? null,
    tda: candidates.tda ?? candidates.sucursal ?? null,
    te: candidates.te ?? null,
    op: candidates.op ?? null,
    ts: candidates.ts ?? null,
    fecha: extracted.fecha ?? candidates.fecha ?? null,
    monto: extracted.monto ?? candidates.monto ?? null,
    subtotal: candidates.subtotal ?? null,
    iva: candidates.iva ?? null,
    autorizacion: candidates.autorizacion ?? null,
    afiliacion: candidates.afiliacion ?? null,
  };
}

function inspectRequiredFieldStatus(pageState) {
  const requiredInputs = (pageState.inputs ?? []).filter((input) => input.enabled && input.required);
  const emptyRequired = requiredInputs.filter((input) => !String(input.value ?? "").trim());

  return {
    requiredCount: requiredInputs.length,
    emptyRequiredCount: emptyRequired.length,
    emptyRequired: emptyRequired.map((input) => ({
      selector: input.selector,
      label: input.label,
      placeholder: input.placeholder,
    })),
  };
}

function inspectFinalSubmitReadiness(pageState) {
  const controls = (pageState.buttons ?? []).filter((button) => {
    const text = String(button.text ?? "");
    const isNavigationTab = /radFacturar/i.test(`${button.id ?? ""} ${button.name ?? ""}`);
    const isHelpTooltip =
      /tooltip/i.test(`${button.classes ?? ""}`) ||
      (/^#?$/.test(String(button.href ?? "")) && /indicar|ayuda|informaci[oó]n/i.test(text));
    return button.looksFinal && !isNavigationTab && !isHelpTooltip;
  });

  return {
    ready: controls.some((control) => control.enabled),
    reason: controls.some((control) => control.enabled)
      ? "final_visible_enabled"
      : controls.length
        ? "final_visible_disabled"
        : "final_not_visible",
    controls,
  };
}

function hasB2SubmitEvidence(validation, requiredStatus) {
  if (!validation?.ok) {
    return false;
  }

  if (requiredStatus?.emptyRequiredCount === 0) {
    return true;
  }

  const completedChecks = (validation.checked ?? []).filter(
    (item) => String(item.actual ?? "").trim() && String(item.expected ?? "").trim(),
  );

  return completedChecks.length >= 3;
}

function trimPageState(pageState) {
  return {
    ...pageState,
    bodyText: String(pageState.bodyText ?? "").slice(0, 1800),
    inputs: (pageState.inputs ?? []).slice(0, 40),
    selects: (pageState.selects ?? []).slice(0, 20),
    buttons: (pageState.buttons ?? []).slice(0, 40),
    alerts: (pageState.alerts ?? []).slice(0, 5),
  };
}

async function captureB2Artifacts(page, { id, prefix }) {
  const directory = getPortalArtifactsDir();
  const outputDir = resolve(directory);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const basename = `${safeFilePart(prefix)}-${safeFilePart(id ?? "job")}-${stamp}`;
  const screenshotFile = `${basename}.png`;
  const htmlFile = `${basename}.html`;

  await mkdir(outputDir, { recursive: true });
  await page.screenshot({ path: resolve(outputDir, screenshotFile), fullPage: true }).catch(() => {});
  await writeFile(resolve(outputDir, htmlFile), await page.content(), "utf8");

  return {
    screenshotPath: displayArtifactPath(directory, screenshotFile),
    htmlPath: displayArtifactPath(directory, htmlFile),
    currentUrl: page.url(),
  };
}

function buildResult({
  status,
  reason,
  statusMessage,
  trace,
  artifacts,
  pageState,
  readiness,
  flowState = null,
  validation = null,
  recoveryAttempts = [],
  downloadResult = null,
}) {
  return {
    status,
    reason,
    statusMessage,
    artifacts,
    b2FlowState: flowState,
    b2Trace: trace,
    b2PageState: trimPageState(pageState),
    b2FinalSubmitReadiness: readiness,
    b2ValidationResult: validation,
    b2RecoveryAttempts: recoveryAttempts,
    b2DownloadResult: downloadResult,
    aiNavigationResult: {
      providerMode: "b2_field_mapper",
      status,
      reason,
      statusMessage,
      artifacts,
      b2FlowState: flowState,
      b2Trace: trace,
      b2FinalSubmitReadiness: readiness,
      b2ValidationResult: validation,
      b2RecoveryAttempts: recoveryAttempts,
      b2DownloadResult: downloadResult,
    },
  };
}

function displayArtifactPath(directory, fileName) {
  const path = isAbsolute(directory) ? resolve(directory, fileName) : join(directory, fileName);
  return path.replaceAll("\\", "/");
}

function safeFilePart(value) {
  return String(value ?? "unknown")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
