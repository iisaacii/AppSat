import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isAbsolute, join, resolve } from "node:path";
import { getAiNavigatorMaxTurns, getPortalArtifactsDir } from "../config/env.mjs";
import { validateAiActionPlan, readAiValue } from "./ai-action-validator.mjs";
import { generateGeminiNavigationPlan } from "./providers/gemini.provider.mjs";
import { selectBestOption } from "../shared/playwright-select-control.mjs";

const finalSubmitControlText = /facturar|generar\s+factura|emitir|timbrar|enviar\s+factura|finalizar/i;

export async function runAiNavigationSession({ job, extracted, template = null, context = {}, failure, portalUrl, prompt }) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== "false",
  });
  const page = await browser.newPage({ acceptDownloads: true, ignoreHTTPSErrors: true });
  const turns = [];
  const executedActions = [];
  const valueSource = buildValueSource({ job, extracted, context });
  let latestArtifacts = null;
  let latestPlan = null;

  try {
    try {
      await page.goto(resolveNavigableUrl(portalUrl), {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    } catch (error) {
      return buildAiStopResult({
        job,
        template,
        portalUrl,
        failure,
        status: "needs_user_action",
        reason: "portal_access_denied",
        statusMessage: `No se pudo acceder al portal: ${error.message}`,
        turns,
        latestPlan,
        latestArtifacts,
      });
    }

    for (let turn = 1; turn <= getAiNavigatorMaxTurns(); turn += 1) {
      const prefillRecords = await prefillKnownFields(page, valueSource);

      if (prefillRecords.length) {
        executedActions.push(...prefillRecords);
        await page.waitForTimeout(300);
      }

      const autoAdvanceRecord = await tryAutoAdvanceKnownInvoiceStep(page, valueSource, executedActions);

      if (autoAdvanceRecord) {
        executedActions.push(autoAdvanceRecord);
        await page.waitForTimeout(300);
      }

      const pageState = await capturePageState(page, { job, template, suffix: `ai-turn-${turn}` });
      latestArtifacts = pageState.artifacts;
      const plan = await generateGeminiNavigationPlan({
        prompt: {
          ...prompt,
          turn,
          executedActions,
          finalSubmitPolicy:
            "FinalSubmit is allowed only through action type finalSubmit. Never use click/clickText for Generar Factura, Emitir, Timbrar or Enviar Factura. The runner will block it unless the job and worker are explicitly approved.",
        },
        pageState: trimPageStateForModel(pageState),
        screenshotPath: pageState.artifacts.screenshotPath,
      });
      latestPlan = plan;
      const validation = validateAiActionPlan(plan, { job, context: valueSource });
      const turnRecord = {
        turn,
        providerStatus: plan.status,
        confidence: plan.confidence,
        reason: plan.reason,
        validation: {
          ok: validation.ok,
          errors: validation.errors,
          finalSubmitGuard: validation.finalSubmitGuard,
        },
        artifacts: pageState.artifacts,
      };

      if (prefillRecords.length) {
        turnRecord.execution = [...prefillRecords];
      }

      if (autoAdvanceRecord) {
        turnRecord.execution = [...(turnRecord.execution ?? []), autoAdvanceRecord];
      }

      turns.push(turnRecord);

      if (plan.providerError) {
        if (plan.recoverableInSession && turn < getAiNavigatorMaxTurns()) {
          const providerError = {
            type: "provider_error",
            status: "failed",
            reason: plan.reason,
            providerError: plan.providerError,
          };
          turnRecord.execution = [...(turnRecord.execution ?? []), providerError];
          executedActions.push(providerError);
          continue;
        }

        if (plan.retryable) {
          const retryAfterMs = normalizeRetryAfterMs(plan.retryAfterMs);
          return buildAiStopResult({
            job,
            template,
            portalUrl,
            failure,
            status: "retry_scheduled",
            reason: "ai_provider_retryable",
            statusMessage: plan.reason ?? "Proveedor IA saturado; reintento programado",
            turns,
            latestPlan,
            latestArtifacts,
            retryAfterMs,
          });
        }

        return buildAiStopResult({
          job,
          template,
          portalUrl,
          failure,
          status: "needs_user_action",
          reason: plan.providerError === "missing_gemini_api_key" ? "ai_provider_not_configured" : "ai_provider_error",
          statusMessage: plan.reason,
          turns,
          latestPlan,
          latestArtifacts,
        });
      }

      if (!validation.ok) {
        const finalSubmitBlocked = validation.errors.some((error) => error.includes("finalSubmit blocked"));

        if (finalSubmitBlocked) {
          const finalSubmitAction = validation.actions.find((action) => action.type === "finalSubmit");
          const readiness = await inspectFinalSubmitReadiness(page, finalSubmitAction);
          turnRecord.validation.finalSubmitReadiness = readiness;

          if (!readiness.ready && turn < getAiNavigatorMaxTurns()) {
            const advanceRecord = await tryAdvanceBeforeFinalSubmit(page, finalSubmitAction);

            if (advanceRecord) {
              turnRecord.execution = [...(turnRecord.execution ?? []), advanceRecord];
              executedActions.push(advanceRecord);
              continue;
            }

            const recoveryRecord = {
              type: "finalSubmit",
              status: "deferred",
              reason:
                "Gemini proposed finalSubmit, but the final control is not visible and enabled yet; continue the current portal step first",
              selector: finalSubmitAction?.selector ?? null,
              text: finalSubmitAction?.text ?? null,
              valueKey: null,
              format: null,
              checked: null,
              hasLiteralValue: false,
              xmlSelector: null,
              pdfSelector: null,
              readiness,
            };
            turnRecord.execution = [...(turnRecord.execution ?? []), recoveryRecord];
            executedActions.push(recoveryRecord);
            continue;
          }
        }

        return buildAiStopResult({
          job,
          template,
          portalUrl,
          failure,
          status: "needs_user_action",
          reason: finalSubmitBlocked ? "ai_final_submit_approval_required" : "ai_action_plan_invalid",
          statusMessage: finalSubmitBlocked
            ? "Gemini llego al submit final, pero falta aprobacion para emitir"
            : "Gemini devolvio acciones que no pasaron validacion",
          turns,
          latestPlan,
          latestArtifacts,
        });
      }

      let actionResult = null;

      try {
        actionResult = await executeAiActions(page, validation.actions, {
          valueSource,
          job,
          template,
          executedActions,
        });
      } catch (error) {
        const executionError = {
          type: "action_execution_failed",
          status: "failed",
          reason: error.message,
          code: error.code ?? null,
          action: error.aiAction ? buildActionRecord(error.aiAction, { status: "failed" }) : null,
          expectedValue: error.expectedValue ?? null,
          availableOptions: error.availableOptions ?? null,
        };
        turnRecord.execution = [...(turnRecord.execution ?? []), executionError];
        executedActions.push(executionError);
        const recoveryRecord = await tryRecoverFiscalSelect(page, error, valueSource);

        if (recoveryRecord && turn < getAiNavigatorMaxTurns()) {
          turnRecord.execution.push(recoveryRecord);
          executedActions.push(recoveryRecord);
          await page.waitForTimeout(500);
          continue;
        }

        const mappedStop = mapActionExecutionStop(error);

        if (mappedStop) {
          return buildAiStopResult({
            job,
            template,
            portalUrl,
            failure,
            status: "needs_user_action",
            reason: mappedStop.reason,
            statusMessage: mappedStop.statusMessage,
            turns,
            latestPlan,
            latestArtifacts,
          });
        }

        if (turn < getAiNavigatorMaxTurns()) {
          continue;
        }

        return buildAiStopResult({
          job,
          template,
          portalUrl,
          failure,
          status: "needs_user_action",
          reason: "ai_action_execution_failed",
          statusMessage: `Gemini propuso acciones validas, pero fallo al ejecutarlas: ${error.message}`,
          turns,
          latestPlan,
          latestArtifacts,
        });
      }

      turnRecord.execution = [...(turnRecord.execution ?? []), ...actionResult.summary];
      const stopAction = actionResult.summary.find((action) => action.type === "stop");

      if (stopAction) {
        return buildAiStopResult({
          job,
          template,
          portalUrl,
          failure,
          status: "needs_user_action",
          reason: "ai_agent_stopped",
          statusMessage: stopAction.reason || plan.reason || "Gemini detuvo la navegacion del portal",
          turns,
          latestPlan,
          latestArtifacts,
        });
      }

      if (!actionResult.downloads && actionResult.summary.some((action) => action.type === "finalSubmit")) {
        const autoDownload = await tryAutoDownloadVisibleCfdi(page, { job, template });

        if (autoDownload) {
          actionResult.downloads = autoDownload.downloads;
          turnRecord.execution.push(autoDownload.actionRecord);
          executedActions.push(autoDownload.actionRecord);
        }
      }

      if (actionResult.downloads?.xmlPath && actionResult.downloads?.pdfPath) {
        return {
          status: "completed",
          statusMessage: "Capa B IA descargo el CFDI",
          reason: "ai_cfdi_downloaded",
          templateId: template?.id ?? null,
          jobId: job.id,
          providerMode: "gemini",
          downloadMode: "ai_gemini",
          xmlPath: actionResult.downloads.xmlPath,
          pdfPath: actionResult.downloads.pdfPath,
          xmlDownloadFileName: actionResult.downloads.xmlDownloadFileName,
          pdfDownloadFileName: actionResult.downloads.pdfDownloadFileName,
          xmlUrl: actionResult.downloads.xmlUrl,
          pdfUrl: actionResult.downloads.pdfUrl,
          artifacts: latestArtifacts,
          aiNavigationResult: buildAiNavigationResult({
            status: "completed",
            portalUrl,
            failure,
            prompt,
            turns,
            latestPlan,
            latestArtifacts,
          }),
        };
      }

      if (plan.status === "cannot_solve") {
        return buildAiStopResult({
          job,
          template,
          portalUrl,
          failure,
          status: "needs_user_action",
          reason: "ai_cannot_solve",
          statusMessage: plan.reason || "Gemini no pudo resolver el portal",
          turns,
          latestPlan,
          latestArtifacts,
        });
      }

      if (plan.status === "ready_for_final_submit" && !validation.actions.some((action) => action.type === "finalSubmit")) {
        return buildAiStopResult({
          job,
          template,
          portalUrl,
          failure,
          status: "needs_user_action",
          reason: "ai_preview_ready",
          statusMessage: "Gemini dejo el portal listo para emision final",
          turns,
          latestPlan,
          latestArtifacts,
        });
      }
    }

    return buildAiStopResult({
      job,
      template,
      portalUrl,
      failure,
      status: "needs_user_action",
      reason: "ai_max_turns_reached",
      statusMessage: "Capa B llego al maximo de turnos sin completar",
      turns,
      latestPlan,
      latestArtifacts,
    });
  } finally {
    await browser.close();
  }
}

async function executeAiActions(page, actions, { valueSource, job, template, executedActions }) {
  const summary = [];

  for (const action of actions) {
    if (action.type === "stop") {
      summary.push(buildActionRecord(action, { status: "stopped" }));
      break;
    }

    if (action.type === "intent") {
      const intentResult = await executeAiIntent(page, action, {
        valueSource,
        job,
        template,
      });

      summary.push(...intentResult.summary);
      executedActions.push(...intentResult.summary);

      if (intentResult.downloads) {
        return { downloads: intentResult.downloads, summary };
      }

      const autoActionRecord = await tryAutoConfirmClientCreationModal(page);

      if (autoActionRecord) {
        summary.push(autoActionRecord);
        executedActions.push(autoActionRecord);
      }

      continue;
    }

    if (action.type === "waitForSelector") {
      await page.locator(action.selector).first().waitFor({
        state: action.state ?? "visible",
        timeout: action.timeoutMs,
      });
    } else if (action.type === "fill") {
      await page.locator(action.selector).fill(String(readAiValue(action, valueSource) ?? ""), {
        timeout: action.timeoutMs,
      });
    } else if (action.type === "setValue") {
      await setElementValue(page.locator(action.selector), readAiValue(action, valueSource), action);
    } else if (action.type === "select") {
      await selectBestOption(page, page.locator(action.selector), readAiValue(action, valueSource), action).catch(
        (error) => {
          error.aiAction = action;
          throw error;
        },
      );
    } else if (action.type === "check") {
      await page.locator(action.selector).setChecked(action.checked ?? true, {
        timeout: action.timeoutMs,
      });
    } else if (action.type === "click") {
      await clickBestVisibleLocator(page.locator(action.selector), action, {
        description: action.selector,
      });
      await afterAiActionWait(page, action);
    } else if (action.type === "clickText") {
      const text = action.text ?? readAiValue(action, valueSource);
      await clickBestVisibleText(page, String(text ?? ""), action);
      await afterAiActionWait(page, action);
    } else if (action.type === "waitForLoadState") {
      await page.waitForLoadState(action.state ?? "domcontentloaded", { timeout: action.timeoutMs });
    } else if (action.type === "screenshot") {
      await capturePageState(page, { job, template, suffix: "ai-action-screenshot" });
    } else if (action.type === "finalSubmit") {
      await clickBestVisibleLocator(page.locator(action.selector), action, {
        description: action.selector,
      });
      await afterAiActionWait(page, action);
    } else if (action.type === "downloadCfdi") {
      const downloads = await captureAiCfdiDownloads(page, action, { job, template });
      const actionRecord = buildActionRecord(action, { status: "completed" });
      summary.push(actionRecord);
      executedActions.push(actionRecord);
      return { downloads, summary };
    }

    const actionRecord = buildActionRecord(action, { status: "completed" });
    summary.push(actionRecord);
    executedActions.push(actionRecord);

    const autoActionRecord = await tryAutoConfirmClientCreationModal(page);

    if (autoActionRecord) {
      summary.push(autoActionRecord);
      executedActions.push(autoActionRecord);
    }
  }

  return { downloads: null, summary };
}

async function executeAiIntent(page, action, { valueSource, job, template }) {
  const intent = action.intent;

  if (intent === "fillVisibleFields") {
    const records = await prefillKnownFields(page, valueSource);

    if (records.length) {
      await page.waitForTimeout(300);
      return {
        downloads: null,
        summary: records.map((record) => ({
          ...record,
          reason: action.reason ?? record.reason,
        })),
      };
    }

    return {
      downloads: null,
      summary: [
        buildActionRecord(
          {
            ...action,
            reason: action.reason ?? "No visible empty field matched known ticket or tax data",
          },
          { status: "completed" },
        ),
      ],
    };
  }

  if (intent === "selectPersonType") {
    const record = await tryEnsurePersonTypeToggle(page, valueSource, {
      reason: action.reason ?? "Selected fiscal person type requested by AI intent",
    });

    if (!record) {
      throw buildAiActionError(action, "No visible persona fisica/moral toggle was available", {
        code: "ai_intent_not_available",
      });
    }

    return { downloads: null, summary: [record] };
  }

  if (intent === "downloadCfdi") {
    const autoDownload = await tryAutoDownloadVisibleCfdi(page, { job, template });

    if (!autoDownload) {
      throw buildAiActionError(action, "No visible XML/PDF CFDI download controls were available", {
        code: "ai_intent_not_available",
      });
    }

    return {
      downloads: autoDownload.downloads,
      summary: [autoDownload.actionRecord],
    };
  }

  const textGroups = {
    search: ["Buscar", "Consultar", "Verificar"],
    validate: ["Validar Ticket", "Validar ticket", "Validar", "Buscar"],
    continue: ["Continuar", "Siguiente", "Aceptar"],
    next: ["Siguiente", "Continuar", "Aceptar"],
    save: ["Guardar", "Registrar", "Agregar", "Continuar"],
    addClient: ["Agregar", "Agregar cliente", "Nuevo cliente", "Guardar", "Registrar"],
    confirmModal: ["Confirmar", "Aceptar", "Si", "Sí"],
    accept: ["Aceptar", "Confirmar", "Si", "Sí"],
  };
  const texts = textGroups[intent];

  if (!texts) {
    throw buildAiActionError(action, `Unsupported AI intent: ${intent}`, {
      code: "ai_intent_not_supported",
    });
  }

  await clickBestVisibleTextOption(page, texts, action);
  await afterAiActionWait(page, action);

  return {
    downloads: null,
    summary: [buildActionRecord(action, { status: "completed" })],
  };
}

async function clickBestVisibleTextOption(page, texts, action) {
  const failures = [];

  for (const text of texts) {
    try {
      await clickBestVisibleText(page, text, action);
      return text;
    } catch (error) {
      failures.push(`${text}: ${error.message}`);
    }
  }

  throw buildAiActionError(action, `No visible control matched any text option: ${texts.join(", ")}`, {
    code: "ai_click_text_not_visible",
    details: failures,
  });
}

async function clickBestVisibleText(page, text, action) {
  const normalizedText = String(text ?? "").trim();

  if (!normalizedText) {
    throw buildAiActionError(action, "Cannot click empty text", {
      code: "ai_click_text_empty",
    });
  }

  const controlSelector = [
    "button",
    "a",
    "[role='button']",
    "input[type='button']",
    "input[type='submit']",
    ".mat-mdc-button-base",
    ".mat-button-base",
    "mat-expansion-panel-header",
  ].join(", ");
  const candidates = [
    page.locator("mat-dialog-container, .mat-dialog-container, [role='dialog'], .modal, .cdk-overlay-pane").getByRole(
      "button",
      { name: normalizedText, exact: action.exact },
    ),
    page.getByRole("button", { name: normalizedText, exact: action.exact }),
    page.getByRole("link", { name: normalizedText, exact: action.exact }),
    page.locator(controlSelector).filter({ hasText: normalizedText }),
    page.getByText(normalizedText, { exact: action.exact }),
  ];

  for (const locator of candidates) {
    const clicked = await clickBestVisibleLocator(locator, action, {
      description: `text "${normalizedText}"`,
      optional: true,
    });

    if (clicked) {
      return;
    }
  }

  throw buildAiActionError(action, `No visible clickable element found for text "${normalizedText}"`, {
    code: "ai_click_text_not_visible",
  });
}

async function clickBestVisibleLocator(locator, action, { description, optional = false } = {}) {
  const timeoutMs = action.timeoutMs ?? 10000;
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;

  while (Date.now() < deadline) {
    const count = Math.min(await locator.count().catch(() => 0), 40);
    lastCount = count;

    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      const visible = await candidate.isVisible({ timeout: 300 }).catch(() => false);

      if (!visible) {
        continue;
      }

      const enabled = await candidate.isEnabled({ timeout: 300 }).catch(() => true);

      if (!enabled) {
        continue;
      }

      await candidate.scrollIntoViewIfNeeded({ timeout: Math.min(timeoutMs, 5000) }).catch(() => {});
      await candidate.click({ timeout: Math.max(1000, Math.min(timeoutMs, 10000)) });
      return true;
    }

    await sleep(250);
  }

  if (optional) {
    return false;
  }

  throw buildAiActionError(action, `No visible enabled element found for ${description ?? "locator"} (${lastCount} matches)`, {
    code: "ai_click_target_not_visible",
  });
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function buildAiActionError(action, message, extra = {}) {
  const error = new Error(message);
  error.aiAction = action;

  Object.assign(error, extra);

  return error;
}

async function inspectFinalSubmitReadiness(page, action) {
  if (!action?.selector) {
    return {
      ready: false,
      count: 0,
      visibleCount: 0,
      enabledCount: 0,
      reason: "missing_selector",
    };
  }

  const locator = page.locator(action.selector);
  const count = Math.min(await locator.count().catch(() => 0), 40);
  let visibleCount = 0;
  let enabledCount = 0;
  let visibleFinalCount = 0;

  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    const visible = await candidate.isVisible({ timeout: 300 }).catch(() => false);

    if (!visible) {
      continue;
    }

    visibleCount += 1;
    const candidateText = await candidate
      .evaluate((element) => String(element.innerText || element.textContent || element.getAttribute("value") || "").trim())
      .catch(() => "");
    const candidateLooksFinal = finalSubmitControlText.test(candidateText);

    if (candidateLooksFinal) {
      visibleFinalCount += 1;
    }

    const enabled = await candidate.isEnabled({ timeout: 300 }).catch(() => true);

    if (enabled && candidateLooksFinal) {
      enabledCount += 1;
    }
  }

  return {
    ready: enabledCount > 0,
    count,
    visibleCount,
    visibleFinalCount,
    enabledCount,
    reason: enabledCount > 0 ? "final_visible_enabled" : visibleFinalCount > 0 ? "final_visible_disabled" : "final_not_visible",
  };
}

async function tryAdvanceBeforeFinalSubmit(page, finalSubmitAction) {
  const advanceTexts = ["Guardar Correo", "Guardar", "Buscar", "Validar", "Validar Ticket", "Continuar", "Siguiente", "Aceptar"];
  const action = {
    type: "intent",
    intent: "continue",
    reason: "Final submit control is disabled; advance the current non-final portal step first",
    timeoutMs: finalSubmitAction?.timeoutMs ?? 10000,
    exact: false,
  };
  let lastRecord = null;

  for (const text of advanceTexts) {
    try {
      await clickBestVisibleText(page, text, action);
      await afterAiActionWait(page, action);
      const readiness = await inspectFinalSubmitReadiness(page, finalSubmitAction);

      lastRecord = {
        type: "intent",
        intent: "continue",
        status: "completed",
        reason: action.reason,
        selector: null,
        text,
        valueKey: null,
        format: null,
        checked: null,
        hasLiteralValue: false,
        xmlSelector: null,
        pdfSelector: null,
        readinessAfterClick: readiness,
      };

      if (readiness.ready) {
        return lastRecord;
      }
    } catch {
      // Try the next safe non-final control.
    }
  }

  return lastRecord;
}

async function tryAutoAdvanceKnownInvoiceStep(page, valueSource, executedActions) {
  if (executedActions.some((action) => action.reason === "auto advanced completed CFDI usage step")) {
    return null;
  }

  const bodyText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  const expectedRegime = valueSource.fiscalCompliance?.expectedFiscalRegime?.label ?? "";
  const expectedUse = valueSource.fiscalCompliance?.expectedCfdiUse?.label ?? "";
  const hasUsageStep = /uso\s+(de\s+)?cfdi/i.test(bodyText);
  const hasExpectedRegime = expectedRegime ? bodyText.includes(expectedRegime) : true;
  const hasExpectedUse = expectedUse ? bodyText.includes(expectedUse) : true;
  const hasEmail = valueSource.taxProfile?.email ? bodyText.includes(valueSource.taxProfile.email) : true;

  if (!hasUsageStep || !hasExpectedRegime || !hasExpectedUse || !hasEmail) {
    return null;
  }

  const readiness = await inspectFinalSubmitReadiness(page, {
    selector: 'button:has-text("Facturar"), a:has-text("Facturar"), input[value*="Facturar"]',
  });

  if (readiness.ready) {
    return null;
  }

  const action = {
    type: "intent",
    intent: "search",
    reason: "auto advanced completed CFDI usage step",
    timeoutMs: 10000,
    exact: false,
  };

  try {
    await clickBestVisibleText(page, "Buscar", action);
    await afterAiActionWait(page, action);

    return {
      type: "intent",
      intent: "search",
      status: "completed",
      reason: action.reason,
      selector: null,
      text: "Buscar",
      valueKey: null,
      format: null,
      checked: null,
      hasLiteralValue: false,
      xmlSelector: null,
      pdfSelector: null,
      readinessBeforeClick: readiness,
    };
  } catch {
    return null;
  }
}

async function prefillKnownFields(page, valueSource) {
  const values = buildPrefillValues(valueSource);
  const records = await page.evaluate((prefillValues) => {
    const normalize = (value) =>
      String(value ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const textFromLabels = (element) => {
      const labels = [];

      if (element.id) {
        labels.push(
          ...[...document.querySelectorAll(`label[for="${cssEscape(element.id)}"], mat-label[for="${cssEscape(element.id)}"]`)].map(
            (label) => label.textContent,
          ),
        );
      }

      labels.push(...[...(element.labels ?? [])].map((label) => label.textContent));

      const formField = element.closest("mat-form-field, .mat-mdc-form-field, .mat-form-field");
      if (formField) {
        labels.push(formField.textContent);
      }

      return labels.join(" ");
    };
    const descriptorFor = (element) =>
      normalize(
        [
          element.id,
          element.name,
          element.getAttribute("placeholder"),
          element.getAttribute("aria-label"),
          textFromLabels(element),
        ].join(" "),
      );
    const selectorFor = (element, index) => {
      const tag = element.tagName.toLowerCase();

      if (element.id) {
        return `#${cssEscape(element.id)}`;
      }

      if (element.name) {
        return `${tag}[name="${cssAttr(element.name)}"]`;
      }

      const placeholder = element.getAttribute("placeholder");
      if (placeholder) {
        return `${tag}[placeholder="${cssAttr(placeholder)}"]`;
      }

      return `${tag}:nth-of-type(${index + 1})`;
    };
    const firstValue = (...items) => items.find((item) => item !== null && item !== undefined && String(item).trim() !== "");
    const pickValue = (descriptor, inputType) => {
      const fields = prefillValues.portalDiscoveryFields ?? {};
      const ticket = prefillValues.ticket ?? {};
      const taxProfile = prefillValues.taxProfile ?? {};

      if (inputType === "date" || descriptor.includes("fecha")) {
        return { valueKey: "ticket.fecha", value: ticket.fecha };
      }

      if (descriptor.includes("rfc") && !descriptor.includes("emisor")) {
        return { valueKey: "taxProfile.rfc", value: taxProfile.rfc };
      }

      if (descriptor.includes("sucursal")) {
        return { valueKey: "context.portalDiscovery.fields.sucursal", value: fields.sucursal };
      }

      if (descriptor.includes("token")) {
        return { valueKey: "context.portalDiscovery.fields.token", value: fields.token };
      }

      if (descriptor.includes("serie")) {
        return { valueKey: "context.portalDiscovery.fields.serie", value: fields.serie };
      }

      if (descriptor.includes("venta")) {
        return { valueKey: "context.portalDiscovery.fields.noVenta", value: firstValue(fields.noVenta, ticket.ticketId) };
      }

      if (descriptor.includes("folio") || descriptor.includes("ticket")) {
        return {
          valueKey: fields.folioTicket ? "context.portalDiscovery.fields.folioTicket" : "ticket.folio",
          value: firstValue(fields.folioTicket, fields.noTicket, ticket.ticketId, ticket.folio),
        };
      }

      if (descriptor.includes("total") || descriptor.includes("monto") || descriptor.includes("importe")) {
        return { valueKey: "ticket.monto", value: ticket.monto };
      }

      if (descriptor.includes("correo") || descriptor.includes("email") || descriptor.includes("e-mail")) {
        return { valueKey: "taxProfile.email", value: taxProfile.email };
      }

      if (descriptor.includes("codigo postal") || descriptor.includes("cod postal") || descriptor.includes(" c p") || descriptor === "cp") {
        return { valueKey: "taxProfile.postalCode", value: taxProfile.postalCode };
      }

      if (descriptor.includes("apellido paterno")) {
        return { valueKey: "taxProfile.paternalLastName", value: taxProfile.paternalLastName };
      }

      if (descriptor.includes("apellido materno")) {
        return { valueKey: "taxProfile.maternalLastName", value: taxProfile.maternalLastName };
      }

      if (descriptor.includes("nombre(s)") || descriptor.includes("nombres") || descriptor.includes("nombre s")) {
        return { valueKey: "taxProfile.firstName", value: taxProfile.firstName };
      }

      if (descriptor.includes("nombre") || descriptor.includes("razon social")) {
        return { valueKey: "taxProfile.legalName", value: taxProfile.legalName };
      }

      return null;
    };
    const cssEscape = (value) => {
      if (globalThis.CSS?.escape) {
        return globalThis.CSS.escape(value);
      }

      return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    };
    const cssAttr = (value) => String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const records = [];
    const elements = [...document.querySelectorAll("input, textarea")];

    elements.forEach((element, index) => {
      const inputType = normalize(element.getAttribute("type"));

      if (
        element.disabled ||
        element.readOnly ||
        ["hidden", "button", "submit", "reset", "checkbox", "radio", "file"].includes(inputType) ||
        !isVisible(element) ||
        String(element.value ?? "").trim()
      ) {
        return;
      }

      const descriptor = descriptorFor(element);
      const picked = pickValue(descriptor, inputType);

      if (!picked?.value && picked?.value !== 0) {
        return;
      }

      const value = inputType === "number" ? String(picked.value) : String(picked.value).trim();
      element.focus();
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new Event("blur", { bubbles: true }));

      records.push({
        type: "setValue",
        status: "completed",
        reason: `generic prefill matched ${descriptor.slice(0, 80)}`,
        selector: selectorFor(element, index),
        text: null,
        valueKey: picked.valueKey,
        format: null,
        checked: null,
        hasLiteralValue: false,
        xmlSelector: null,
        pdfSelector: null,
      });
    });

    return records;
  }, values);

  const selectRecords = await prefillKnownSelects(page, valueSource);

  return [...records, ...selectRecords];
}

async function prefillKnownSelects(page, valueSource) {
  const candidates = await page.evaluate(() => {
    const normalize = (value) =>
      String(value ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const cssEscape = (value) => {
      if (globalThis.CSS?.escape) {
        return globalThis.CSS.escape(value);
      }

      return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    };
    const cssAttr = (value) => String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const selectorFor = (element, index) => {
      const tag = element.tagName.toLowerCase();

      if (element.id) {
        return `#${cssEscape(element.id)}`;
      }

      if (element.getAttribute("name")) {
        return `${tag}[name="${cssAttr(element.getAttribute("name"))}"]`;
      }

      if (element.getAttribute("formcontrolname")) {
        return `${tag}[formcontrolname="${cssAttr(element.getAttribute("formcontrolname"))}"]`;
      }

      return `${tag}:nth-of-type(${index + 1})`;
    };
    const textFromLabels = (element) => {
      const labels = [];

      if (element.id) {
        labels.push(...[...document.querySelectorAll(`label[for="${cssEscape(element.id)}"]`)].map((label) => label.textContent));
      }

      labels.push(...[...(element.labels ?? [])].map((label) => label.textContent));

      const formField = element.closest("mat-form-field, .mat-mdc-form-field, .mat-form-field, .form-group, .mb-3, .row");
      if (formField) {
        labels.push(formField.textContent);
      }

      return labels.join(" ");
    };
    const descriptorFor = (element) =>
      normalize(
        [
          element.id,
          element.getAttribute("name"),
          element.getAttribute("formcontrolname"),
          element.getAttribute("placeholder"),
          element.getAttribute("aria-label"),
          element.textContent,
          textFromLabels(element),
        ].join(" "),
      );

    return [...document.querySelectorAll("select, mat-select, [role='combobox']")]
      .map((element, index) => ({ element, index }))
      .filter(({ element }) => !element.disabled && element.getAttribute("aria-disabled") !== "true" && isVisible(element))
      .map(({ element, index }) => {
        const descriptor = descriptorFor(element);

        if (descriptor.includes("regimen") || descriptor.includes("régimen")) {
          return {
            selector: selectorFor(element, index),
            valueKey: "fiscalCompliance.expectedFiscalRegime.code",
            format: "taxRegime:code",
            reason: `generic select prefill matched ${descriptor.slice(0, 80)}`,
          };
        }

        if (descriptor.includes("uso cfdi") || descriptor.includes("uso de cfdi") || descriptor.includes("cfdi")) {
          return {
            selector: selectorFor(element, index),
            valueKey: "fiscalCompliance.expectedCfdiUse.code",
            format: "cfdiUse:code",
            reason: `generic select prefill matched ${descriptor.slice(0, 80)}`,
          };
        }

        return null;
      })
      .filter(Boolean)
      .slice(0, 10);
  });
  const records = [];

  for (const candidate of candidates) {
    const action = {
      type: "select",
      selector: candidate.selector,
      valueKey: candidate.valueKey,
      format: candidate.format,
      reason: candidate.reason,
      timeoutMs: 10000,
    };

    try {
      await selectBestOption(page, page.locator(candidate.selector), readAiValue(action, valueSource), action);
      records.push(buildActionRecord(action, { status: "completed" }));
    } catch {
      // Generic prefill is opportunistic; Gemini still gets a turn with the current page state.
    }
  }

  return records;
}

async function tryAutoConfirmClientCreationModal(page) {
  const deadline = Date.now() + 6000;
  const dialog = page.locator('mat-dialog-container, .mat-dialog-container, [role="dialog"]').filter({
    hasText: /No se encontr[oó].*cliente|RFC solicitado/i,
  });

  while (Date.now() < deadline) {
    const hasClientCreationPrompt = await dialog.first().isVisible({ timeout: 500 }).catch(() => false);

    if (hasClientCreationPrompt) {
      const confirm = dialog.getByRole("button", { name: /^Confirmar$/i });
      const clicked = await clickBestVisibleLocator(confirm, { timeoutMs: 10000 }, {
        description: "client creation Confirmar button",
        optional: true,
      });

      if (!clicked) {
        return null;
      }

      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});

      return {
        type: "clickText",
        status: "completed",
        reason: "RFC not found; confirmed client creation flow",
        selector: null,
        text: "Confirmar",
        valueKey: null,
        format: null,
        checked: null,
        hasLiteralValue: false,
        xmlSelector: null,
        pdfSelector: null,
      };
    }
  }

  return null;
}

async function tryRecoverFiscalSelect(page, error, valueSource) {
  if (error?.code !== "select_option_not_available" || error.aiAction?.type !== "select") {
    return null;
  }

  const actionProbe = `${error.aiAction.valueKey ?? ""} ${error.aiAction.selector ?? ""} ${error.aiAction.reason ?? ""}`.toLowerCase();

  if (!actionProbe.includes("fiscalregime") && !actionProbe.includes("regimen") && !actionProbe.includes("regfis")) {
    return null;
  }

  return tryEnsurePersonTypeToggle(page, valueSource, {
    reason: `Fiscal regime option missing; selected ${valueSource.fiscalCompliance?.personType} toggle before retry`,
  });
}

async function tryEnsurePersonTypeToggle(page, valueSource, { reason } = {}) {
  const personType = valueSource.fiscalCompliance?.personType;
  const selector =
    personType === "fisica"
      ? 'mat-checkbox#valPersonafisica input[type="checkbox"], #valPersonafisica input[type="checkbox"], [name="valPersonafisica"] input[type="checkbox"]'
      : personType === "moral"
        ? 'mat-checkbox#valPersonamoral input[type="checkbox"], #valPersonamoral input[type="checkbox"], [name="valPersonamoral"] input[type="checkbox"]'
        : null;
  const hostSelector =
    personType === "fisica"
      ? "mat-checkbox#valPersonafisica, #valPersonafisica"
      : personType === "moral"
        ? "mat-checkbox#valPersonamoral, #valPersonamoral"
        : null;

  if (!selector) {
    return null;
  }

  const checkbox = page.locator(selector).first();
  const host = page.locator(hostSelector).first();
  const exists = (await checkbox.count()) > 0;
  const inputVisible = exists && (await checkbox.isVisible({ timeout: 1000 }).catch(() => false));
  const hostVisible = hostSelector ? await host.isVisible({ timeout: 1000 }).catch(() => false) : false;

  if (!exists || (!inputVisible && !hostVisible)) {
    return null;
  }

  const checked = await checkbox.isChecked({ timeout: 1000 }).catch(() => false);

  if (checked) {
    return null;
  }

  if (inputVisible) {
    await checkbox.setChecked(true, { timeout: 10000 });
  } else {
    await clickBestVisibleLocator(host, { timeoutMs: 10000 }, { description: hostSelector });
  }

  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});

  return {
    type: "check",
    status: "completed",
    reason: reason ?? `Selected ${personType} toggle`,
    selector,
    text: null,
    valueKey: "fiscalCompliance.personType",
    format: null,
    checked: true,
    hasLiteralValue: false,
    xmlSelector: null,
    pdfSelector: null,
  };
}

async function tryAutoDownloadVisibleCfdi(page, { job, template }) {
  const pairs = [
    {
      xmlSelector: 'a:has-text("Descargar XML"), button:has-text("Descargar XML")',
      pdfSelector: 'a:has-text("Descargar PDF"), button:has-text("Descargar PDF")',
    },
    {
      xmlSelector: 'a:has-text("XML"), button:has-text("XML"), [download$=".xml"], [href$=".xml"]',
      pdfSelector: 'a:has-text("PDF"), button:has-text("PDF"), [download$=".pdf"], [href$=".pdf"]',
    },
  ];

  for (const pair of pairs) {
    const xmlLocator = page.locator(pair.xmlSelector).first();
    const pdfLocator = page.locator(pair.pdfSelector).first();
    const xmlVisible = await xmlLocator.isVisible({ timeout: 1000 }).catch(() => false);
    const pdfVisible = await pdfLocator.isVisible({ timeout: 1000 }).catch(() => false);

    if (!xmlVisible || !pdfVisible) {
      continue;
    }

    const action = {
      type: "downloadCfdi",
      reason: "CFDI download controls detected after finalSubmit",
      xmlSelector: pair.xmlSelector,
      pdfSelector: pair.pdfSelector,
      timeoutMs: 30000,
    };

    return {
      downloads: await captureAiCfdiDownloads(page, action, { job, template }),
      actionRecord: buildActionRecord(action, { status: "completed" }),
    };
  }

  return null;
}

async function captureAiCfdiDownloads(page, action, { job, template }) {
  const xmlLocator = page.locator(action.xmlSelector).first();
  const pdfLocator = page.locator(action.pdfSelector).first();
  await xmlLocator.waitFor({ state: "visible", timeout: action.timeoutMs });
  await pdfLocator.waitFor({ state: "visible", timeout: action.timeoutMs });

  const xml = await captureDownloadFile(page, {
    locator: xmlLocator,
    kind: "xml",
    job,
    template,
    timeoutMs: action.timeoutMs,
  });
  const pdf = await captureDownloadFile(page, {
    locator: pdfLocator,
    kind: "pdf",
    job,
    template,
    timeoutMs: action.timeoutMs,
  });

  return {
    xmlPath: xml.path,
    pdfPath: pdf.path,
    xmlDownloadFileName: xml.fileName,
    pdfDownloadFileName: pdf.fileName,
    xmlUrl: xml.url,
    pdfUrl: pdf.url,
  };
}

async function captureDownloadFile(page, { locator, kind, job, template, timeoutMs }) {
  const configuredDir = getPortalArtifactsDir();
  const outputDir = resolve(configuredDir);
  await mkdir(outputDir, { recursive: true });

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: timeoutMs ?? 30000 }),
    locator.click({ timeout: timeoutMs ?? 10000 }),
  ]);
  const suggested = sanitizeFileName(download.suggestedFilename?.() ?? `cfdi.${kind}`, kind);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${safeFilePart(template?.id ?? "ai")}-${safeFilePart(job.id)}-${stamp}-${kind}-${suggested}`;
  const outputPath = resolve(outputDir, fileName);
  await download.saveAs(outputPath);

  return {
    path: displayArtifactPath(configuredDir, fileName),
    fileName: suggested,
    url: typeof download.url === "function" ? download.url() : null,
  };
}

async function capturePageState(page, { job, template, suffix }) {
  const artifacts = await captureAiArtifacts(page, { job, template, suffix });
  const state = await page.evaluate(() => {
    const normalize = (value) =>
      String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const cssEscape = (value) => {
      if (globalThis.CSS?.escape) {
        return globalThis.CSS.escape(value);
      }

      return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    };
    const cssAttr = (value) => String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const selectorFor = (element, index = 0) => {
      const tag = element.tagName.toLowerCase();

      if (element.id) {
        return `#${cssEscape(element.id)}`;
      }

      if (element.getAttribute("name")) {
        return `${tag}[name="${cssAttr(element.getAttribute("name"))}"]`;
      }

      if (element.getAttribute("formcontrolname")) {
        return `${tag}[formcontrolname="${cssAttr(element.getAttribute("formcontrolname"))}"]`;
      }

      if (element.getAttribute("placeholder")) {
        return `${tag}[placeholder="${cssAttr(element.getAttribute("placeholder"))}"]`;
      }

      return `${tag}:nth-of-type(${index + 1})`;
    };
    const textFromLabels = (element) => {
      const labels = [];

      if (element.id) {
        labels.push(...[...document.querySelectorAll(`label[for="${cssEscape(element.id)}"]`)].map((label) => label.textContent));
      }

      labels.push(...[...(element.labels ?? [])].map((label) => label.textContent));

      const formField = element.closest("mat-form-field, .mat-mdc-form-field, .mat-form-field, .form-group, .mb-3, .row");
      if (formField) {
        labels.push(formField.textContent);
      }

      return normalize(labels.join(" ")).slice(0, 220);
    };
    const elementSummary = (element) => ({
      tag: element.tagName.toLowerCase(),
      id: element.id || null,
      name: element.getAttribute("name"),
      selector: selectorFor(element),
      type: element.getAttribute("type"),
      role: element.getAttribute("role"),
      text: normalize(element.innerText || element.textContent).slice(0, 140),
      labelText: textFromLabels(element),
      placeholder: element.getAttribute("placeholder"),
      ariaLabel: element.getAttribute("aria-label"),
      value: "value" in element ? normalize(element.value).slice(0, 140) : element.getAttribute("value"),
      disabled: element.disabled === true || element.getAttribute("aria-disabled") === "true",
      visible: isVisible(element),
    });
    const visibleElements = (selector) => [...document.querySelectorAll(selector)].filter(isVisible);
    const visibleButtons = visibleElements(
      "button, a, [role='button'], input[type='button'], input[type='submit'], .mat-mdc-button-base, .mat-button-base, mat-expansion-panel-header",
    )
      .slice(0, 60)
      .map(elementSummary);
    const visibleDialogs = visibleElements("mat-dialog-container, .mat-dialog-container, [role='dialog'], .modal, .cdk-overlay-pane")
      .slice(0, 10)
      .map((element, index) => ({
        selector: selectorFor(element, index),
        text: normalize(element.innerText || element.textContent).slice(0, 1200),
        buttons: [...element.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']")]
          .filter(isVisible)
          .slice(0, 20)
          .map(elementSummary),
      }));
    const visibleMessages = visibleElements(
      ".alert, .toast, .toast-message, .mat-mdc-snack-bar-label, .mat-simple-snack-bar-content, .swal2-container, [role='alert'], .invalid-feedback, .mat-error",
    )
      .slice(0, 30)
      .map((element, index) => ({
        selector: selectorFor(element, index),
        text: normalize(element.innerText || element.textContent).slice(0, 500),
      }));

    return {
      title: document.title || null,
      currentUrl: location.href,
      visibleTextPreview: normalize(document.body?.innerText).slice(0, 3000),
      interactiveElements: visibleElements("input, select, textarea, button, a, mat-select, [role='combobox']")
        .slice(0, 80)
        .map(elementSummary),
      fieldDescriptors: visibleElements("input, select, textarea, mat-select, [role='combobox']")
        .slice(0, 60)
        .map(elementSummary),
      visibleButtons,
      visibleDialogs,
      visibleMessages,
    };
  });

  return {
    ...state,
    artifacts,
  };
}

async function captureAiArtifacts(page, { job, template, suffix }) {
  const configuredDir = getPortalArtifactsDir();
  const outputDir = resolve(configuredDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const basename = `${safeFilePart(template?.id ?? "ai")}-${safeFilePart(job.id)}-${stamp}-${suffix}`;
  const screenshotFile = `${basename}.png`;
  const htmlFile = `${basename}.html`;
  const screenshotPath = resolve(outputDir, screenshotFile);
  const htmlPath = resolve(outputDir, htmlFile);

  await mkdir(outputDir, { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await writeFile(htmlPath, await page.content(), "utf8");

  return {
    screenshotPath: displayArtifactPath(configuredDir, screenshotFile),
    htmlPath: displayArtifactPath(configuredDir, htmlFile),
    currentUrl: page.url(),
  };
}

function buildAiStopResult({
  job,
  template,
  portalUrl,
  failure,
  status,
  reason,
  statusMessage,
  turns,
  latestPlan,
  latestArtifacts,
  retryAfterMs = null,
}) {
  const retryAt = retryAfterMs ? new Date(Date.now() + retryAfterMs).toISOString() : null;

  return {
    status,
    statusMessage,
    reason,
    safeStop: true,
    requiresUserAction: true,
    templateId: template?.id ?? null,
    jobId: job.id,
    providerMode: "gemini",
    ...(retryAfterMs ? { retryAfterMs, retryAt, error: statusMessage } : {}),
    artifacts: latestArtifacts,
    aiNavigationResult: buildAiNavigationResult({
      status: reason,
      portalUrl,
      failure,
      prompt: null,
      turns,
      latestPlan,
      latestArtifacts,
    }),
  };
}

function buildAiNavigationResult({ status, portalUrl, failure, prompt, turns, latestPlan, latestArtifacts }) {
  return {
    providerMode: "gemini",
    status,
    portalUrl,
    failure,
    prompt,
    turns,
    latestPlan,
    artifacts: latestArtifacts,
    proposedActions: latestPlan?.actions ?? [],
    learnedTemplateCandidate: latestPlan?.learnedTemplateCandidate ?? null,
  };
}

function buildActionRecord(action, { status }) {
  return {
    type: action.type,
    status,
    reason: action.reason ?? null,
    intent: action.intent ?? null,
    selector: action.selector ?? null,
    text: action.text ?? null,
    valueKey: action.valueKey ?? null,
    format: action.format ?? null,
    checked: action.checked ?? null,
    hasLiteralValue: action.value !== undefined && action.value !== null,
    xmlSelector: action.xmlSelector ?? null,
    pdfSelector: action.pdfSelector ?? null,
  };
}

function mapActionExecutionStop(error) {
  if (error?.code !== "select_option_not_available" || error.aiAction?.type !== "select") {
    return null;
  }

  const actionProbe = `${error.aiAction.valueKey ?? ""} ${error.aiAction.selector ?? ""} ${error.aiAction.reason ?? ""}`.toLowerCase();

  if (actionProbe.includes("fiscalregime") || actionProbe.includes("regimen") || actionProbe.includes("regfis")) {
    return {
      reason: "tax_regime_not_available",
      statusMessage: "El portal no ofrece el regimen fiscal del perfil fiscal del usuario",
    };
  }

  if (actionProbe.includes("cfdiuse") || actionProbe.includes("cfdi")) {
    return {
      reason: "cfdi_use_not_available",
      statusMessage: "El portal no ofrece el uso de CFDI del perfil fiscal del usuario",
    };
  }

  return null;
}

function buildValueSource({ job, extracted, context }) {
  const nameParts = inferNameParts(job.taxProfile?.legalName);

  return {
    ticket: {
      rfcEmisor: extracted?.rfcEmisor ?? context.rfcEmisor ?? job.rfcEmisor ?? null,
      folio: context.folio ?? extracted?.folio ?? job.folio ?? null,
      ticketId: context.ticketId ?? extracted?.ocrCandidates?.ticketId ?? null,
      fecha: context.ticketDate ?? extracted?.fecha ?? job.fecha ?? null,
      monto: context.monto ?? extracted?.monto ?? job.monto ?? null,
    },
    taxProfile: {
      rfc: context.taxRfc ?? job.taxProfile?.rfc ?? job.rfcReceptor ?? null,
      legalName: context.taxLegalName ?? job.taxProfile?.legalName ?? null,
      email: context.taxEmail ?? job.taxProfile?.email ?? null,
      firstName: context.taxFirstName ?? job.taxProfile?.firstName ?? nameParts.firstName,
      paternalLastName: context.taxPaternalLastName ?? job.taxProfile?.paternalLastName ?? nameParts.paternalLastName,
      maternalLastName: context.taxMaternalLastName ?? job.taxProfile?.maternalLastName ?? nameParts.maternalLastName,
      fiscalRegime: context.taxFiscalRegime ?? job.taxProfile?.fiscalRegime ?? null,
      fiscalRegimes: context.taxFiscalRegimes ?? job.taxProfile?.fiscalRegimes ?? null,
      cfdiUse: context.taxCfdiUse ?? job.taxProfile?.cfdiUse ?? null,
      postalCode: context.taxPostalCode ?? job.taxProfile?.postalCode ?? null,
      street: context.taxStreet ?? job.taxProfile?.street ?? null,
      exteriorNumber: context.taxExteriorNumber ?? job.taxProfile?.exteriorNumber ?? null,
      interiorNumber: context.taxInteriorNumber ?? job.taxProfile?.interiorNumber ?? null,
      neighborhood: context.taxNeighborhood ?? job.taxProfile?.neighborhood ?? null,
      municipality: context.taxMunicipality ?? job.taxProfile?.municipality ?? null,
      state: context.taxState ?? job.taxProfile?.state ?? null,
      country: context.taxCountry ?? job.taxProfile?.country ?? null,
    },
    fiscalCompliance: context.fiscalCompliance ?? job.fiscalCompliance ?? null,
    context,
  };
}

function inferNameParts(legalName) {
  const parts = String(legalName ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length >= 3) {
    return {
      firstName: parts.slice(0, -2).join(" "),
      paternalLastName: parts.at(-2),
      maternalLastName: parts.at(-1),
    };
  }

  if (parts.length === 2) {
    return {
      firstName: parts[0],
      paternalLastName: parts[1],
      maternalLastName: null,
    };
  }

  return {
    firstName: parts[0] ?? null,
    paternalLastName: null,
    maternalLastName: null,
  };
}

function buildPrefillValues(valueSource) {
  return {
    ticket: valueSource.ticket ?? {},
    taxProfile: valueSource.taxProfile ?? {},
    portalDiscoveryFields:
      valueSource.context?.portalDiscovery?.fields ??
      valueSource.context?.extractedData?.portalDiscovery?.fields ??
      {},
  };
}

function trimPageStateForModel(pageState) {
  return {
    title: pageState.title,
    currentUrl: pageState.currentUrl,
    visibleTextPreview: pageState.visibleTextPreview,
    interactiveElements: pageState.interactiveElements,
    fieldDescriptors: pageState.fieldDescriptors,
    visibleButtons: pageState.visibleButtons,
    visibleDialogs: pageState.visibleDialogs,
    visibleMessages: pageState.visibleMessages,
  };
}

async function setElementValue(locator, value, action) {
  await locator.waitFor({ state: "attached", timeout: action.timeoutMs });
  await locator.evaluate((element, nextValue) => {
    element.value = String(nextValue ?? "");
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function afterAiActionWait(page, action) {
  if (action.waitForLoadState) {
    await page.waitForLoadState(action.waitForLoadState, { timeout: action.timeoutMs });
  } else {
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  }

  await waitForPortalSettled(page, action);
}

async function waitForPortalSettled(page, action) {
  const timeoutMs = Math.min(action.timeoutMs ?? 10000, 15000);

  await page
    .waitForFunction(
      () => {
        const isVisible = (element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };

        return [...document.querySelectorAll(".animationload, .osahanloading, .mat-progress-spinner, .mat-spinner")]
          .every((element) => element.classList.contains("d-none") || !isVisible(element));
      },
      null,
      { timeout: timeoutMs },
    )
    .catch(() => {});

  await page.waitForTimeout(300).catch(() => {});
}

function resolveNavigableUrl(value) {
  const raw = String(value ?? "").trim();

  if (/^https?:\/\//i.test(raw) || /^file:\/\//i.test(raw)) {
    return raw;
  }

  if (raw && isAbsolute(raw)) {
    return pathToFileURL(resolve(raw)).href;
  }

  return raw;
}

function displayArtifactPath(directory, fileName) {
  const path = isAbsolute(directory) ? resolve(directory, fileName) : join(directory, fileName);
  return path.replaceAll("\\", "/");
}

function sanitizeFileName(value, kind) {
  const fallback = `cfdi.${kind}`;
  const fileName = String(value ?? fallback)
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");

  return fileName || fallback;
}

function safeFilePart(value) {
  return String(value ?? "unknown")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizeRetryAfterMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(number, 15 * 60 * 1000) : 30000;
}
