import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildFiscalComplianceContext } from "../fiscal/fiscal-compliance.service.mjs";
import { runB2Lab } from "../b2-lab/b2-runner.mjs";

const fixturePath = getCliOption("fixture");
const profilePath = getCliOption("profile") ?? "data/tax-profiles/sample.json";
const printFull = process.argv.includes("--full");

if (!fixturePath) {
  throw new Error("Missing --fixture=data/stagehand-fixtures/example.json");
}

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
  id: fixture.id ?? "b2_ticket_lab",
  ticketFileUrl: fixture.ticketImagePath ?? fixture.ticketFileUrl ?? null,
  rfcReceptor: taxProfile.rfc,
  taxProfile,
  fiscalCompliance,
  portalFinalSubmitApproved: false,
  manualOverrides: {
    ...extracted,
  },
};

const result = await runB2Lab({
  job,
  extracted,
  taxProfile,
  fiscalCompliance,
  portalUrl: fixture.portalUrl,
  maxTurns: Number(getCliOption("max-turns") ?? process.env.B2_MAX_TURNS ?? 8),
});

const summary = {
  ok: ["completed", "needs_user_action", "retry_scheduled"].includes(result.status),
  fixture: fixturePath,
  portalUrl: fixture.portalUrl,
  status: result.status,
  reason: result.reason,
  statusMessage: result.statusMessage,
  artifacts: result.artifacts,
  b2FlowState: result.b2FlowState,
  pageClassification: result.b2PageState?.pageClassification ?? null,
  finalSubmitReadiness: result.b2FinalSubmitReadiness,
  b2ValidationResult: result.b2ValidationResult,
  b2RecoveryAttemptCount: result.b2RecoveryAttempts?.length ?? 0,
  b2DownloadResult: result.b2DownloadResult,
  portalUrlRescue: result.b2Trace?.portalUrlRescue ?? null,
  trace: {
    turns: result.b2Trace?.turns?.length ?? null,
    executedActionCount: result.b2Trace?.executedActions?.length ?? null,
    failedActionCount: result.b2Trace?.failedActions?.length ?? null,
    lastPlan: result.b2Trace?.turns?.at(-1)?.plan ?? null,
  },
};

console.log(JSON.stringify(printFull ? result : summary, null, 2));

function getCliOption(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}
