import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runBillingOrchestrator } from "../orchestrator/billing-orchestrator.mjs";

const useGemini = process.argv.includes("--gemini");
const printFull = process.argv.includes("--full");
const singleBest = process.argv.includes("--single-best");
const approveFinalSubmit = process.argv.includes("--approve-final-submit");
const allowFinalSubmit = process.argv.includes("--allow-final-submit") || approveFinalSubmit;
const portalUrl = getCliOption("portal-url") ?? "https://facturacionpintu.com.mx";
const ticketImagePath = getCliOption("ticket") ?? join(process.env.USERPROFILE ?? ".", "Downloads", "ticket_pintura.jpg");
const profilePath = getCliOption("profile") ?? "data/tax-profiles/sample.json";

process.env.CFDI_STORAGE_MODE = process.env.CFDI_STORAGE_MODE ?? "mock";
process.env.OCR_ENGINE = "mock";
process.env.PORTAL_RUNNER_MODE = "playwright";
process.env.PORTAL_USE_FIXTURE = "false";
process.env.PORTAL_ALLOW_FINAL_SUBMIT = allowFinalSubmit ? "true" : "false";
process.env.AI_NAVIGATOR_ALLOW_FINAL_SUBMIT = allowFinalSubmit ? "true" : "false";
process.env.AI_NAVIGATOR_MODE = useGemini ? "gemini" : (process.env.AI_NAVIGATOR_MODE ?? "mock");
process.env.BILLING_FORCE_AI_NAVIGATION = "true";
process.env.AI_NAVIGATOR_MAX_TURNS = process.env.AI_NAVIGATOR_MAX_TURNS ?? "8";
process.env.HEADLESS = process.env.HEADLESS ?? "true";

const taxProfile = JSON.parse(await readFile(resolve(profilePath), "utf8"));
const ticketOcrText = `
PINTURAS MAR S.A DE CV
SUPER AVENIDA LOMAS VERDES 464
PISO 3 COL. LOMAS VERDES
NAUCALPAN DE JUAREZ
ESTADO DE MEXICO, C.P. 53120
RFC: PMA1805167L1
Regimen General de Ley Personas Morales
15 mayo, 2026 9:51:14 AM
No.Ticket: 37240 No.Venta:37240
SUCURSAL 1806 SOR JUANA
AV. MAGDALENA MZ 5 LT 34
CENTRO TLALNEPANTLA 54000
TLALNEPANTLA DE BAZ EDO. DE MEX.
1 PZ AEROCOMEX NEGRO BRILLANTE
Total: 99.50
DATOS PARA FACTURAR:
Link: pinturerias.com.mx
Sucursal 1806
Folio Ticket 37240
Serie TRPALA
Token 32580782
Vigente para facturar en linea hasta las 8:00 pm del ultimo dia del mes en que realizo su compra.
`;

const events = [];
const result = await runBillingOrchestrator(
  {
    id: `pinturerias_layer_b_${useGemini ? "gemini" : "mock"}`,
    uid: "billing_lab_local",
    ticketFileUrl: ticketImagePath,
    ...(singleBest
      ? {
          aiPortalUrl: portalUrl,
          portalCandidateUrl: portalUrl,
          portalCandidates: [
            {
              url: portalUrl,
              source: "lab_single_best",
              confidence: 1,
            },
          ],
        }
      : {}),
    rfcReceptor: taxProfile.rfc,
    taxProfile,
    portalFinalSubmitApproved: approveFinalSubmit,
    manualOverrides: {
      rfcEmisor: "PMA1805167L1",
      folio: "37240",
      fecha: "2026-05-15",
      monto: 99.5,
      ocrText: ticketOcrText,
      ocrTextPreview: ticketOcrText.slice(0, 1200),
      ocrCandidates: {
        rfc: ["PMA1805167L1"],
        folioTicket: "37240",
        noTicket: "37240",
        noVenta: "37240",
        ticketId: "37240",
        sucursal: "1806",
        serie: "TRPALA",
        token: "32580782",
        fecha: "2026-05-15",
        monto: 99.5,
      },
    },
  },
  {
    onEvent: (event) => {
      events.push({
        type: event.type,
        status: event.status,
        message: event.message,
        metadata: event.metadata ?? {},
      });
    },
  },
);

const summary = {
  ok: ["completed", "needs_user_action", "retry_scheduled"].includes(result.status),
  providerMode: useGemini ? "gemini" : "mock",
  ticketImagePath,
  status: result.status,
  reason: result.reason ?? result.aiNavigationResult?.reason ?? null,
  statusMessage: result.statusMessage ?? null,
  extracted: {
    rfcEmisor: result.rfcEmisor ?? null,
    folio: result.folio ?? null,
    fecha: result.fecha ?? null,
    monto: result.monto ?? null,
    portalUrl: result.portalUrl ?? null,
    portalDiscoveryFields: result.portalDiscovery?.fields ?? result.extractedData?.portalDiscovery?.fields ?? null,
  },
  portalCandidates: result.portalCandidates ?? result.portalDiscovery?.portalCandidates ?? [],
  fiscalCompliance: {
    ready: result.fiscalCompliance?.ready ?? null,
    reason: result.fiscalCompliance?.reason ?? null,
    personType: result.fiscalCompliance?.personType ?? null,
    fiscalRegimeCodes: result.fiscalCompliance?.fiscalRegimeCodes ?? null,
    cfdiUseCode: result.fiscalCompliance?.expectedCfdiUse?.code ?? null,
  },
  aiNavigation: summarizeAiNavigation(result.aiNavigationResult),
  learnedTemplateSave: result.aiNavigationResult?.learnedTemplateSave ?? null,
  events,
};

console.log(JSON.stringify(printFull ? result : summary, null, 2));

function summarizeAiNavigation(aiNavigationResult) {
  if (!aiNavigationResult) {
    return null;
  }

  return {
    providerMode: aiNavigationResult.providerMode ?? null,
    status: aiNavigationResult.status ?? null,
    reason: aiNavigationResult.reason ?? null,
    statusMessage: aiNavigationResult.statusMessage ?? null,
    portalUrl: aiNavigationResult.portalUrl ?? null,
    currentUrl: aiNavigationResult.artifacts?.currentUrl ?? null,
    safeStop: aiNavigationResult.safeStop ?? null,
    finalSubmitGuard: aiNavigationResult.finalSubmitGuard ?? null,
    artifacts: aiNavigationResult.artifacts ?? null,
    attempts: aiNavigationResult.aiNavigationAttempts ?? null,
    executedActionCount: Array.isArray(aiNavigationResult.executedActions)
      ? aiNavigationResult.executedActions.length
      : null,
    failedActions: aiNavigationResult.failedActions ?? null,
    proposedActionCount: Array.isArray(aiNavigationResult.proposedActions)
      ? aiNavigationResult.proposedActions.length
      : null,
  };
}

function getCliOption(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}
