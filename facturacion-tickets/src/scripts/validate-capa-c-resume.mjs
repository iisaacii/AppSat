import { findPortalTemplateById } from "../portals/portal-registry.mjs";
import { runInteractiveCheckpoint } from "../user-action/interactive-checkpoint-runner.mjs";

const template = await findPortalTemplateById("capa-c-captcha-demo");

if (!template) {
  throw new Error("Missing capa-c-captcha-demo template");
}

process.env.CAPA_C_KEEP_BROWSER_OPEN = "false";

const taxProfile = {
  rfc: "XAXX010101000",
  legalName: "PERSONA CONTRIBUYENTE DEMO",
  email: "pruebas@easysat.dev",
  fiscalRegime: "605 - Sueldos y Salarios e Ingresos Asimilados a Salarios",
  cfdiUse: "S01 - Sin efectos fiscales",
  postalCode: "54040",
};

const result = await runInteractiveCheckpoint({
  checkpoint: {
    kind: "portal_checkpoint.v1",
    portalUrl: template.portalUrl,
    templateId: template.id,
    rfcEmisor: "AAA010101AAA",
    ticketData: {
      folio: "12345",
      fecha: "2026-05-21",
      monto: 99.5,
    },
    reason: "captcha_required",
  },
  template,
  fixture: {
    id: "validate_capa_c_resume",
    rfcEmisor: "AAA010101AAA",
    folio: "12345",
    fecha: "2026-05-21",
    monto: 99.5,
  },
  taxProfile,
  approveFinalSubmit: true,
  headless: true,
  autoSubmitAfterUser: false,
  waitForUser: false,
  keepBrowserOpen: false,
  useFixture: true,
  runId: "validate_capa_c_resume",
});

assert(result.ok === true, "interactive resume should complete setup");
assert(result.status === "needs_user_action", "demo should stop at user action");
assert(result.stoppedAt?.reason === "captcha_required", "demo should stop at captcha");
assert(
  result.executedSteps.some((step) => step.selector === "#rfc-receptor") &&
    result.executedSteps.some((step) => step.selector === "#uso-cfdi"),
  "demo should execute form-fill recipe",
);

console.log(
  JSON.stringify(
    {
      ok: true,
      status: result.status,
      reason: result.reason,
      stoppedAt: result.stoppedAt?.reason,
      runDir: result.runDir,
      steps: result.executedSteps.length,
      currentUrl: result.currentUrl,
    },
    null,
    2,
  ),
);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
