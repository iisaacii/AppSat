import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isAbsolute, join, resolve } from "node:path";
import { getAiNavigatorMode, getPortalArtifactsDir, isAiNavigationEnabled } from "../config/env.mjs";
import {
  buildFiscalComplianceContext,
  isFiscalComplianceBlocking,
} from "../fiscal/fiscal-compliance.service.mjs";
import { logger } from "../shared/logger.mjs";
import { runAiNavigationSession } from "./ai-session-runner.mjs";

const safeStopReasonsForAi = new Set([
  "template_safe_stop",
  "invoice_preview_not_available",
  "tax_form_disabled_after_ticket_validation",
  "b3_dynamic_replay_required",
  "b3_selector_extraction_required",
]);

const businessStopReasons = new Set([
  "invoice_preview_ready",
  "ticket_validation_rejected",
  "cfdi_use_not_supported_by_regime",
  "cfdi_use_not_available",
  "tax_regime_not_available",
  "ticket_outside_current_fiscal_year",
]);

export function shouldTryAiNavigationForSafeStop(result) {
  if (!result?.safeStop) {
    return false;
  }

  if (businessStopReasons.has(result.reason)) {
    return false;
  }

  return safeStopReasonsForAi.has(result.reason);
}

export function canTryAiNavigation() {
  return isAiNavigationEnabled();
}

export async function runAiNavigationFallback({ job, extracted, template = null, context = {}, failure }) {
  const mode = getAiNavigatorMode();
  const fiscalCompliance =
    context?.fiscalCompliance ?? job?.fiscalCompliance ?? buildFiscalComplianceContext(job?.taxProfile);
  const aiJob = {
    ...job,
    fiscalCompliance,
  };
  const aiContext = {
    ...context,
    fiscalCompliance,
  };
  const portalUrl = resolvePortalUrlForAi({ job: aiJob, extracted, template, context: aiContext });
  const baseResult = {
    status: "needs_user_action",
    templateId: template?.id ?? null,
    jobId: job.id,
    providerMode: mode,
    failure,
    portalUrl: portalUrl ?? null,
  };

  if (isFiscalComplianceBlocking(fiscalCompliance)) {
    return {
      ...baseResult,
      safeStop: true,
      requiresUserAction: true,
      reason: fiscalCompliance.reason,
      statusMessage: fiscalCompliance.statusMessage,
      fiscalCompliance,
      aiNavigationResult: {
        providerMode: mode,
        status: "fiscal_compliance_blocked",
        failure,
        fiscalCompliance,
      },
    };
  }

  if (!isAiNavigationEnabled()) {
    return {
      ...baseResult,
      safeStop: true,
      requiresUserAction: true,
      reason: "ai_navigation_disabled",
      statusMessage: "Capa B deshabilitada por configuracion",
      aiNavigationResult: {
        providerMode: mode,
        status: "disabled",
        failure,
      },
    };
  }

  if (!portalUrl) {
    return {
      ...baseResult,
      safeStop: true,
      requiresUserAction: true,
      reason: "ai_portal_url_required",
      statusMessage: "Capa B requiere URL del portal para este emisor",
      aiNavigationResult: {
        providerMode: mode,
        status: "missing_portal_url",
        failure,
      },
    };
  }

  logger.info("Running AI navigation fallback.", {
    jobId: job.id,
    templateId: template?.id ?? null,
    mode,
    portalUrl,
    failureReason: failure?.reason ?? null,
  });

  const prompt = buildVisionNavigationPrompt({
    job: aiJob,
    extracted,
    template,
    context: aiContext,
    failure,
    portalUrl,
  });

  if (mode === "gemini") {
    return runAiNavigationSession({
      job: aiJob,
      extracted,
      template,
      context: aiContext,
      failure,
      portalUrl,
      prompt,
    });
  }

  const pageState = await capturePortalStateForAi({ job: aiJob, template, portalUrl });

  return {
    ...baseResult,
    safeStop: true,
    requiresUserAction: true,
    reason: mode === "mock" ? "ai_navigation_mock_ready" : "ai_navigation_provider_not_implemented",
    statusMessage:
      mode === "mock"
        ? "Capa B capturo el portal; falta conectar proveedor IA real"
        : `Capa B no tiene implementado el proveedor ${mode}`,
    artifacts: pageState.artifacts,
    aiNavigationResult: {
      providerMode: mode,
      status: mode === "mock" ? "mock_ready" : "provider_not_implemented",
      portalUrl,
      failure,
      prompt,
      pageState: {
        title: pageState.title,
        currentUrl: pageState.currentUrl,
        visibleTextPreview: pageState.visibleTextPreview,
        interactiveElements: pageState.interactiveElements,
      },
      proposedActions: [],
      learnedTemplateCandidate: null,
    },
  };
}

function resolvePortalUrlForAi({ job, extracted, template, context }) {
  return (
    firstString(job.aiPortalUrl) ??
    firstString(job.portalCandidateUrl) ??
    firstString(job.portalUrl) ??
    firstString(context.portalUrl) ??
    firstString(template?.portalUrl) ??
    firstString(extracted?.portalUrl) ??
    firstString(job.portalCandidates?.[0]?.url)
  );
}

async function capturePortalStateForAi({ job, template, portalUrl }) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== "false",
  });
  const page = await browser.newPage({ ignoreHTTPSErrors: true });

  try {
    await page.goto(resolveNavigableUrl(portalUrl), {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

    const pageState = await page.evaluate(() => {
      const normalize = (value) =>
        String(value ?? "")
          .replace(/\s+/g, " ")
          .trim();
      const elementSummary = (element) => ({
        tag: element.tagName.toLowerCase(),
        id: element.id || null,
        name: element.getAttribute("name"),
        type: element.getAttribute("type"),
        role: element.getAttribute("role"),
        text: normalize(element.innerText || element.textContent).slice(0, 140),
        placeholder: element.getAttribute("placeholder"),
        ariaLabel: element.getAttribute("aria-label"),
        value: "value" in element ? normalize(element.value).slice(0, 140) : element.getAttribute("value"),
        disabled: element.disabled === true || element.getAttribute("aria-disabled") === "true",
      });

      return {
        title: document.title || null,
        currentUrl: location.href,
        visibleTextPreview: normalize(document.body?.innerText).slice(0, 3000),
        interactiveElements: [...document.querySelectorAll("input, select, textarea, button, a, mat-select, [role='combobox']")]
          .filter((element) => {
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          })
          .slice(0, 80)
          .map(elementSummary),
      };
    });
    const artifacts = await captureAiArtifacts(page, {
      job,
      template,
      suffix: "ai-navigation",
    });

    return {
      ...pageState,
      artifacts,
    };
  } finally {
    await browser.close();
  }
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

function buildVisionNavigationPrompt({ job, extracted, template, context, failure, portalUrl }) {
  const nameParts = inferNameParts(job.taxProfile?.legalName);

  return {
    role: "portal_navigation_agent",
    objective:
      "Identify invoice portal fields and propose deterministic Playwright actions. You may propose finalSubmit only when the invoice is ready; the runner will enforce approval guards.",
    safety:
      "Use action type finalSubmit for invoice emission. Never hide irreversible actions inside click/clickText. Stop before payments, cancellations, deletions, or unrelated account actions.",
    fieldMappingRules: [
      "Ticket field venta/id/ID de venta must use ticket.ticketId, never ticket.monto.",
      "Ticket field total/importe/monto must use ticket.monto.",
      "Ticket field folio/folio venta must use ticket.folio.",
      "If the ticket includes portalDiscoveryFields such as sucursal, folioTicket, serie or token, use valueKey context.portalDiscovery.fields.<fieldName> for those portal-specific fields.",
      "Before clicking Buscar, Validar, Continuar or similar controls, fill every visible search/input field in the current step. For labels/placeholders like Num. Sucursal or Sucursal use context.portalDiscovery.fields.sucursal.",
      "If the page initially asks for RFC and Sucursal, fill both in the same turn before clicking Buscar.",
      "If the portal has a Validar Ticket button/link and Continuar is disabled, click Validar Ticket before Continuar.",
      "If a modal says the RFC/client was not found and asks whether to add a new client, click Confirmar; this is not invoice emission.",
      "For common page commands, prefer action type intent over fragile text selectors: search, validate, continue, next, save, addClient, confirmModal, accept, selectPersonType, fillVisibleFields.",
      "Use intent confirmModal for modal buttons like Confirmar/Aceptar. Do not use clickText Confirmar, because the runner treats free-form Confirmar as risky unless scoped by intent.",
      "Use visibleButtons, visibleDialogs, visibleMessages and fieldDescriptors to understand the active step. If repeated buttons exist, target the current visible step or use an intent.",
      "Use fiscalCompliance as hard context: select only the fiscal regime codes and CFDI use codes allowed there. Never substitute another regime/use because it is available in the portal.",
      "If the expected fiscal regime is missing, first look for persona fisica/persona moral toggles, RFC refresh, postal-code refresh, or a prior step that unlocks the correct catalog. If it remains unavailable, stop and explain that the portal does not offer the expected fiscal option.",
      "Invoice emission buttons such as Generar Factura, Emitir, Timbrar or Enviar Factura must use action type finalSubmit.",
      "After finalSubmit, propose downloadCfdi when XML and PDF download controls are visible.",
      "For native selects, Angular Material mat-select, or visible comboboxes with stable selectors, prefer action type select with selector and valueKey; the runner will open the widget and match options by code/text.",
    ],
    portal: {
      url: portalUrl,
      templateId: template?.id ?? null,
      portalFamily: template?.portalFamily ?? null,
      failure,
    },
    ticket: {
      rfcEmisor: extracted?.rfcEmisor ?? context.rfcEmisor ?? job.rfcEmisor ?? null,
      folio: context.folio ?? extracted?.folio ?? job.folio ?? null,
      ticketId: context.ticketId ?? extracted?.ocrCandidates?.ticketId ?? null,
      fecha: context.ticketDate ?? extracted?.fecha ?? job.fecha ?? null,
      monto: context.monto ?? extracted?.monto ?? job.monto ?? null,
      portalDiscoveryFields: extracted?.portalDiscovery?.fields ?? context.portalDiscovery?.fields ?? null,
      portalDiscoveryQrValues: extracted?.portalDiscovery?.qrValues ?? context.portalDiscovery?.qrValues ?? [],
    },
    taxProfile: {
      rfc: context.taxRfc ?? job.taxProfile?.rfc ?? job.rfcReceptor ?? null,
      legalName: context.taxLegalName ?? job.taxProfile?.legalName ?? null,
      firstName: context.taxFirstName ?? job.taxProfile?.firstName ?? nameParts.firstName,
      paternalLastName: context.taxPaternalLastName ?? job.taxProfile?.paternalLastName ?? nameParts.paternalLastName,
      maternalLastName: context.taxMaternalLastName ?? job.taxProfile?.maternalLastName ?? nameParts.maternalLastName,
      email: context.taxEmail ?? job.taxProfile?.email ?? null,
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
    },
    fiscalCompliance: context.fiscalCompliance ?? job.fiscalCompliance ?? null,
    expectedJsonShape: {
      confidence: "0..1",
      actions: [
        {
          type: "intent|waitForSelector|fill|setValue|select|check|click|clickText|finalSubmit|downloadCfdi|stop",
          intent:
            "required only for intent: fillVisibleFields|search|validate|continue|next|save|addClient|confirmModal|accept|selectPersonType|downloadCfdi",
          selector: "css selector",
          valueKey: "ticket.folio|taxProfile.rfc|fiscalCompliance.expectedFiscalRegime.code|...",
          format:
            "optional: date:dd/mm/yyyy|number:fixed2|taxRegime:code|cfdiUse:code|state:mexico-portal|uppercase|digits",
          xmlSelector: "required only for downloadCfdi",
          pdfSelector: "required only for downloadCfdi",
          reason: "why this action is needed",
        },
      ],
      learnedTemplateCandidate: {
        portalFamily: "string",
        requiredFields: [],
        steps: [],
      },
    },
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

function firstString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
