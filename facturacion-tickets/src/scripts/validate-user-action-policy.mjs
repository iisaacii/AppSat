import assert from "node:assert/strict";
import {
  buildResolvedAlreadyInvoicedResult,
  buildUserActionRequiredResult,
  normalizeUserActionReason,
} from "../orchestrator/user-action-policy.mjs";

const job = {
  uid: "demo_user",
  taxProfileId: "billing_lab_default",
  portalCandidateUrl: "https://facturacion.example.com",
  taxProfile: {
    rfc: "XAXX010101000",
    legalName: "PERSONA CONTRIBUYENTE DEMO",
    email: "pruebas@appsat.dev",
    fiscalRegime: "605 - Sueldos y Salarios e Ingresos Asimilados a Salarios",
    cfdiUse: "S01 - Sin efectos fiscales",
    postalCode: "54040",
  },
};
const extracted = {
  rfcEmisor: "AAA010101AAA",
  folio: "12345",
  fecha: "2026-05-21",
  monto: 99.5,
  codigoFacturacion: "ABC123",
};
const template = {
  id: "example-template",
  name: "Portal ejemplo",
  portalFamily: "example",
  portalUrl: "https://facturacion.example.com",
  steps: [
    {
      type: "fill",
      selector: "#ticket",
      valueFrom: "codigoFacturacion",
    },
    {
      type: "fill",
      selector: "#rfc",
      valueFrom: "taxRfc",
    },
    {
      type: "click",
      selector: "#continuar",
    },
    {
      type: "stop",
      reason: "captcha_required",
      message: "Resolver CAPTCHA",
    },
  ],
};

const alreadyInvoiced = buildResolvedAlreadyInvoicedResult({
  job,
  extracted,
  template,
  portalRunResult: {
    reason: "ticket_already_invoiced",
    statusMessage: "Este ticket ya fue facturado.",
    artifacts: {
      screenshotStoragePath: "portal-artifacts/demo/screenshot.png",
    },
  },
});

assert.equal(alreadyInvoiced.status, "resolved");
assert.equal(alreadyInvoiced.userAction.status, "resolved");
assert.equal(alreadyInvoiced.userAction.reason, "ticket_already_invoiced");
assert.equal(alreadyInvoiced.userAction.evidence.screenshotStoragePath, "portal-artifacts/demo/screenshot.png");
assert.equal(alreadyInvoiced.fallbackResult, null);

const dataRejected = buildUserActionRequiredResult({
  reason: "ticket_not_found",
  statusMessage: "No encontramos el ticket.",
  job,
  extracted,
  template,
  portalRunResult: {
    reason: "ticket_not_found",
    portalMessage: "Codigo de facturacion invalido",
    missingFields: ["codigoFacturacion"],
  },
});

assert.equal(dataRejected.status, "needs_user_action");
assert.equal(dataRejected.userAction.status, "user_action_required");
assert.equal(dataRejected.userAction.reason, "ticket_data_rejected");
assert.equal(dataRejected.userAction.expectedNextStep, "review_and_retry");
assert.equal(dataRejected.userAction.editableFields[0].key, "codigoFacturacion");
assert.equal(dataRejected.userAction.checkpoint.portalUrl, "https://facturacion.example.com");

const captcha = buildUserActionRequiredResult({
  reason: "captcha_detected",
  job,
  extracted,
  template,
  portalRunResult: {
    currentUrl: "https://facturacion.example.com/captcha",
    artifacts: {
      screenshotPath: "artifacts/captcha.png",
    },
  },
});

assert.equal(captcha.userAction.reason, "captcha_required");
assert.equal(captcha.userAction.expectedNextStep, "resume_interactive_checkpoint");
assert.equal(captcha.userAction.editableFields.length, 0);
assert.equal(captcha.userAction.checkpoint.currentUrl, "https://facturacion.example.com/captcha");
assert.equal(captcha.userAction.mobileHandoff.kind, "flutter_webview_handoff.v1");
assert.equal(captcha.userAction.mobileHandoff.mode, "flutter_webview");
assert.equal(captcha.userAction.mobileHandoff.initialUrl, "https://facturacion.example.com/captcha");
assert.deepEqual(captcha.userAction.mobileHandoff.allowedAutofillHosts, ["facturacion.example.com"]);
assert.equal(captcha.userAction.mobileHandoff.prefillData.ticket.folio, "12345");
assert.equal(captcha.userAction.mobileHandoff.prefillData.fiscal.rfc, "XAXX010101000");
assert.equal(captcha.userAction.mobileHandoff.expectedUserAction, "resolve_captcha_and_continue");
assert.equal(captcha.userAction.mobileHandoff.autofill.kind, "webview_autofill.v1");
assert.equal(captcha.userAction.mobileHandoff.autofill.canRunInExternalBrowser, false);
assert.ok(captcha.userAction.mobileHandoff.autofill.steps.some((step) => step.selector === "#ticket"));
assert.ok(captcha.userAction.mobileHandoff.autofill.script.includes("__appSatAutofill"));

const captchaBlockedWording = buildUserActionRequiredResult({
  reason: "captcha_required",
  statusMessage: "El portal requiere resolver un CAPTCHA para continuar, lo cual no está permitido.",
  job,
  extracted,
  template,
  portalRunResult: {
    currentUrl: "https://facturacion.example.com/captcha",
  },
});

assert.equal(
  captchaBlockedWording.userAction.message,
  "El portal requiere CAPTCHA. Continúa en el portal para resolverlo y descargar la factura.",
);

const login = buildUserActionRequiredResult({
  reason: "login_required",
  job,
  extracted,
  template,
  portalRunResult: {
    currentUrl: "https://facturacion.example.com/login",
  },
});

assert.equal(login.userAction.reason, "login_required");
assert.equal(login.userAction.expectedNextStep, "resume_interactive_checkpoint");
assert.equal(login.userAction.editableFields.length, 0);

const blocked = buildUserActionRequiredResult({
  reason: "cloudflare_blocked",
  job,
  extracted,
  template,
  portalRunResult: {
    currentUrl: "https://facturacion.example.com/access-denied",
  },
});

assert.equal(blocked.userAction.reason, "portal_blocked");
assert.equal(blocked.userAction.expectedNextStep, "resume_interactive_checkpoint");
assert.equal(blocked.userAction.editableFields.length, 0);

const accessDenied = buildUserActionRequiredResult({
  reason: "access_denied",
  job,
  extracted,
  template,
  portalRunResult: {
    currentUrl: "https://facturacion.example.com/forbidden",
  },
});

assert.equal(accessDenied.userAction.reason, "portal_blocked");
assert.equal(accessDenied.userAction.expectedNextStep, "resume_interactive_checkpoint");
assert.equal(accessDenied.userAction.editableFields.length, 0);

const modalBlocked = buildUserActionRequiredResult({
  reason: "modal_blocking",
  job,
  extracted,
  template,
  portalRunResult: {
    currentUrl: "https://facturacion.example.com/modal",
  },
});

assert.equal(modalBlocked.userAction.reason, "portal_blocked");
assert.equal(modalBlocked.userAction.expectedNextStep, "resume_interactive_checkpoint");

const manual = buildUserActionRequiredResult({
  reason: "portal_template_missing",
  job,
  extracted,
  template: null,
});

assert.equal(manual.userAction.reason, "manual_portal_required");
assert.equal(manual.userAction.expectedNextStep, "resume_interactive_checkpoint");
assert.ok(manual.userAction.editableFields.some((field) => field.key === "codigoFacturacion"));

assert.equal(normalizeUserActionReason("portal_template_missing"), "manual_portal_required");
assert.equal(normalizeUserActionReason("access_denied"), "portal_blocked");

console.log("user-action policy validation passed");
