import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { runBillingOrchestrator } from "../orchestrator/billing-orchestrator.mjs";
import { findPortalTemplateByRfc } from "../portals/portal-registry.mjs";
import { resolveTemplateFields } from "../portals/template-fields.mjs";
import { runPortalTemplate } from "../portals/template-runner.mjs";

const useGemini = process.argv.includes("--gemini");
const fixturePath = resolve("src/portals/fixtures/oxxo-real-validation-portal.html");
const context = JSON.parse(await readFile(resolve("data/portal-contexts/oxxo-real-validation.sample.json"), "utf8"));

process.env.CFDI_STORAGE_MODE = "mock";
process.env.OCR_ENGINE = "mock";
process.env.PORTAL_RUNNER_MODE = "playwright";
process.env.PORTAL_USE_FIXTURE = "true";
process.env.PORTAL_ALLOW_FINAL_SUBMIT = "true";
process.env.AI_NAVIGATOR_ALLOW_FINAL_SUBMIT = "true";

const template = await findPortalTemplateByRfc("CCO8605231N4");

if (!template) {
  throw new Error("OXXO template not found.");
}

const aResult = await runLayerAFixture();
const bResult = await runForcedLayerB();

console.log(
  JSON.stringify(
    {
      ok: aResult.completed && bResult.completed,
      geminiRequested: useGemini,
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
      layerA: aResult,
      layerB: bResult,
    },
    null,
    2,
  ),
);

async function runLayerAFixture() {
  const fieldResolution = resolveTemplateFields(template, context);

  if (fieldResolution.missingFields.length) {
    return {
      completed: false,
      reason: "missing_fields",
      missingFields: fieldResolution.missingFields.map((field) => field.name),
    };
  }

  const result = await runPortalTemplate(
    {
      ...template,
      steps: template.steps.map((step) =>
        step.type === "finalSubmit"
          ? {
              ...step,
              allowSubmit: true,
            }
          : step,
      ),
    },
    {
      ...context,
      ...fieldResolution.resolved,
      id: "oxxo_ab_layer_a_fixture",
      portalFinalSubmitApproved: true,
    },
  );

  return {
    completed: Boolean(result.xmlPath && result.pdfPath),
    status: result.status ?? "completed",
    reason: result.reason ?? "cfdi_downloaded",
    xmlPath: result.xmlPath ?? null,
    pdfPath: result.pdfPath ?? null,
  };
}

async function runForcedLayerB() {
  const previousForce = process.env.BILLING_FORCE_AI_NAVIGATION;
  const previousAiMode = process.env.AI_NAVIGATOR_MODE;

  process.env.BILLING_FORCE_AI_NAVIGATION = "true";
  process.env.AI_NAVIGATOR_MODE = useGemini ? "gemini" : "mock";

  try {
    const result = await runBillingOrchestrator({
      id: `oxxo_ab_layer_b_${useGemini ? "gemini" : "mock"}`,
      ticketFileUrl: "mock://ticket-oxxo.jpg",
      aiPortalUrl: pathToFileURL(fixturePath).href,
      portalFinalSubmitApproved: true,
      taxProfile: context.taxProfile,
      manualOverrides: {
        rfcEmisor: context.rfcEmisor,
        folio: context.folio,
        fecha: context.fecha,
        monto: context.monto,
        ocrCandidates: context.ocrCandidates,
      },
    });

    return {
      completed: result.status === "completed",
      status: result.status,
      reason: result.reason ?? result.aiNavigationResult?.reason ?? null,
      statusMessage: result.statusMessage ?? null,
      xmlPath: result.aiNavigationResult?.xmlPath ?? result.resultXmlStoragePath ?? result.resultXmlUrl ?? null,
      pdfPath: result.aiNavigationResult?.pdfPath ?? result.resultPdfStoragePath ?? result.resultPdfUrl ?? null,
      attempts: result.aiNavigationResult?.aiNavigationAttempts ?? null,
      learnedTemplateSave: result.aiNavigationResult?.learnedTemplateSave ?? null,
    };
  } finally {
    if (previousForce === undefined) {
      delete process.env.BILLING_FORCE_AI_NAVIGATION;
    } else {
      process.env.BILLING_FORCE_AI_NAVIGATION = previousForce;
    }

    if (previousAiMode === undefined) {
      delete process.env.AI_NAVIGATOR_MODE;
    } else {
      process.env.AI_NAVIGATOR_MODE = previousAiMode;
    }
  }
}
