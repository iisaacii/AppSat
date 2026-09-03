import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildFiscalComplianceContext } from "../fiscal/fiscal-compliance.service.mjs";
import { runStagehandLab } from "../stagehand-lab/stagehand-runner.mjs";

const fixturePath = getCliOption("fixture");
const mode = getCliOption("mode") ?? "learn";
const printFull = process.argv.includes("--full");
const stopBeforeFinalSubmit = process.argv.includes("--stop-before-final-submit");
const approveFinalSubmit = !stopBeforeFinalSubmit;
const allowFinalSubmit = !stopBeforeFinalSubmit;
const profilePath = getCliOption("profile") ?? "data/tax-profiles/sample.json";

if (!fixturePath) {
  throw new Error("Missing --fixture=data/stagehand-fixtures/example.json");
}

process.env.STAGEHAND_LAB_ENABLED = "true";
process.env.STAGEHAND_ENV = process.env.STAGEHAND_ENV ?? "LOCAL";
process.env.STAGEHAND_MODEL = process.env.STAGEHAND_MODEL ?? "google/gemini-3.1-flash-lite";
process.env.STAGEHAND_ALLOW_FINAL_SUBMIT = allowFinalSubmit ? "true" : (process.env.STAGEHAND_ALLOW_FINAL_SUBMIT ?? "false");
process.env.HEADLESS = process.env.HEADLESS ?? "true";

const fixture = JSON.parse(await readFile(resolve(fixturePath), "utf8"));
const taxProfile = fixture.taxProfile ?? JSON.parse(await readFile(resolve(profilePath), "utf8"));
const fiscalCompliance = fixture.fiscalCompliance ?? buildFiscalComplianceContext(taxProfile);
const extracted = {
  sourceType: fixture.sourceType ?? "lab_fixture",
  ocrEngine: fixture.ocrEngine ?? "manual_lab",
  rfcEmisor: fixture.rfcEmisor,
  folio: fixture.folio,
  fecha: fixture.fecha,
  monto: fixture.monto,
  ocrText: fixture.ocrText ?? "",
  ocrTextPreview: (fixture.ocrText ?? "").slice(0, 1200),
  ocrCandidates: fixture.ocrCandidates ?? {},
};
const job = {
  id: fixture.id ?? "stagehand_ticket_lab",
  uid: "billing_lab_local",
  ticketFileUrl: fixture.ticketImagePath ?? fixture.ticketFileUrl ?? null,
  rfcReceptor: taxProfile.rfc,
  taxProfile,
  fiscalCompliance,
  aiPortalUrl: fixture.portalUrl,
  portalCandidateUrl: fixture.portalUrl,
  portalCandidates: fixture.portalUrl
    ? [
        {
          url: fixture.portalUrl,
          source: fixture.portalSource ?? "stagehand_ticket_lab_fixture",
          confidence: 1,
        },
      ]
    : [],
  portalFinalSubmitApproved: approveFinalSubmit,
  manualOverrides: {
    ...extracted,
  },
};

const result = await runStagehandLab({
  mode,
  job,
  extracted,
  taxProfile,
  fiscalCompliance,
  portalUrl: fixture.portalUrl,
});

const summary = {
  ok: ["completed", "needs_user_action", "retry_scheduled"].includes(result.status),
  fixture: fixturePath,
  mode,
  portalUrl: fixture.portalUrl,
  status: result.status,
  reason: result.reason ?? result.aiNavigationResult?.reason ?? null,
  statusMessage: result.statusMessage ?? null,
  portalLearningState: result.portalLearningState ?? null,
  stagehandCacheStatus: result.stagehandCacheStatus ?? null,
  finalSubmitGuard: result.finalSubmitGuard ?? result.aiNavigationResult?.finalSubmitGuard ?? null,
  artifacts: result.artifacts ?? result.aiNavigationResult?.artifacts ?? null,
  cfdiValidationResult: result.cfdiValidationResult ?? null,
  downloads: {
    xmlPath: result.xmlPath ?? null,
    pdfPath: result.pdfPath ?? null,
  },
  trace: {
    executedActionCount: result.stagehandTrace?.executedActions?.length ?? null,
    failedActionCount: result.stagehandTrace?.failedActions?.length ?? null,
    stagehandActCount: result.stagehandTrace?.stagehandActs?.length ?? null,
    observedActionCount: result.stagehandTrace?.observedActions?.length ?? null,
  },
};

console.log(JSON.stringify(printFull ? result : summary, null, 2));

function getCliOption(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}
