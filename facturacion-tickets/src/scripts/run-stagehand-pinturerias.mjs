import { buildPintureriasStagehandFixture } from "../stagehand-lab/pinturerias-fixture.mjs";
import { runStagehandLab } from "../stagehand-lab/stagehand-runner.mjs";

const mode = getCliOption("mode") ?? (process.argv.includes("--replay") ? "replay" : "learn");
const printFull = process.argv.includes("--full");
const approveFinalSubmit = process.argv.includes("--approve-final-submit");
const allowFinalSubmit = process.argv.includes("--allow-final-submit") || approveFinalSubmit;
const portalUrl = getCliOption("portal-url") ?? "https://facturacionpintu.com.mx";
const ticketImagePath = getCliOption("ticket");
const profilePath = getCliOption("profile");

process.env.STAGEHAND_LAB_ENABLED = "true";
process.env.STAGEHAND_ENV = process.env.STAGEHAND_ENV ?? "LOCAL";
process.env.STAGEHAND_MODEL = process.env.STAGEHAND_MODEL ?? "google/gemini-3.1-flash-lite";
process.env.STAGEHAND_ALLOW_FINAL_SUBMIT = allowFinalSubmit ? "true" : (process.env.STAGEHAND_ALLOW_FINAL_SUBMIT ?? "false");
process.env.HEADLESS = process.env.HEADLESS ?? "true";

const fixture = await buildPintureriasStagehandFixture({
  portalUrl,
  ...(ticketImagePath ? { ticketImagePath } : {}),
  ...(profilePath ? { profilePath } : {}),
  approveFinalSubmit,
});

const result = await runStagehandLab({
  mode,
  ...fixture,
});

const summary = {
  ok: ["completed", "needs_user_action", "retry_scheduled"].includes(result.status),
  mode,
  portalUrl,
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
    xmlUrl: result.xmlUrl ?? null,
    pdfUrl: result.pdfUrl ?? null,
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
