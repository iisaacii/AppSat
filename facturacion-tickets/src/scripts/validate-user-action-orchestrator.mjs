import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runBillingOrchestrator } from "../orchestrator/billing-orchestrator.mjs";
import { buildUserActionRequiredResult } from "../orchestrator/user-action-policy.mjs";

process.env.OCR_ENGINE = "mock";
process.env.AI_NAVIGATOR_MODE = "disabled";
process.env.B3_BROWSER_USE_ENABLED = "false";
process.env.STAGEHAND_LAB_ENABLED = "false";
process.env.PORTAL_DISCOVERY_PROBE_ENABLED = "false";

const taxProfile = JSON.parse(await readFile(resolve("data/tax-profiles/sample.json"), "utf8"));
const events = [];

const firstPass = await runBillingOrchestrator(
  {
    id: "capa_c_unknown_portal_test",
    uid: "demo_user",
    ticketFileUrl: "mock://unknown-ticket.jpg",
    taxProfileId: "billing_lab_default",
    taxProfile,
    portalFinalSubmitApproved: true,
  },
  {
    onEvent: async (event) => events.push(event),
  },
);

assert.equal(firstPass.status, "needs_user_action");
assert.equal(firstPass.reason, "ocr_review_required");
assert.equal(firstPass.userAction.status, "user_action_required");
assert.equal(firstPass.userAction.reason, "ocr_review_required");
assert.equal(firstPass.userAction.expectedNextStep, "review_and_retry");
assert.equal(firstPass.ocrReview.reviewMode, "mandatory_user_confirmation");
assert.ok(firstPass.userAction.editableFields.some((field) => field.key === "rfcEmisor"));
assert.ok(events.some((event) => event.type === "ocr_review_required"));

const confirmedEvents = [];
const result = await runBillingOrchestrator(
  {
    id: "capa_c_unknown_portal_test",
    uid: "demo_user",
    ticketFileUrl: "mock://unknown-ticket.jpg",
    taxProfileId: "billing_lab_default",
    taxProfile,
    ocrCheckpoint: firstPass.ocrCheckpoint,
    extractedData: firstPass.extractedData,
    ocrReviewConfirmed: true,
    portalFinalSubmitApproved: true,
  },
  {
    onEvent: async (event) => confirmedEvents.push(event),
  },
);

assert.equal(result.status, "needs_user_action");
assert.equal(result.reason, "manual_portal_required");
assert.equal(result.userAction.status, "user_action_required");
assert.equal(result.userAction.reason, "manual_portal_required");
assert.equal(result.userAction.expectedNextStep, "resume_interactive_checkpoint");
assert.equal(result.userAction.checkpoint.rfcEmisor, "XXX010101XXX");
assert.equal(result.userAction.checkpoint.ticketData.folio, "UNKNOWN-001");
assert.equal(result.fallbackResult.reason, "portal_template_missing");
assert.ok(confirmedEvents.some((event) => event.type === "portal_missing"));
assert.ok(confirmedEvents.some((event) => event.type === "ocr_checkpoint_reused"));
assert.ok(!confirmedEvents.some((event) => event.type === "ocr_started"));

console.log(
  JSON.stringify(
    {
      ok: true,
      firstPass: {
        status: firstPass.status,
        reason: firstPass.reason,
        reviewMode: firstPass.ocrReview.reviewMode,
        editableFields: firstPass.userAction.editableFields.map((field) => field.key),
      },
      status: result.status,
      reason: result.reason,
      userAction: {
        status: result.userAction.status,
        reason: result.userAction.reason,
        expectedNextStep: result.userAction.expectedNextStep,
        checkpoint: result.userAction.checkpoint,
      },
      events: confirmedEvents.map((event) => event.type),
    },
    null,
    2,
  ),
);

// Test: Loop Mitigation for Unbillable Tickets
console.log("Running unit tests for buildUserActionRequiredResult loop mitigation...");

const testUnbillableConfirmed = buildUserActionRequiredResult({
  reason: "ticket_validation_rejected",
  statusMessage: "Folio no encontrado",
  job: { ocrReviewConfirmed: true },
});

assert.equal(testUnbillableConfirmed.status, "failed");
assert.equal(testUnbillableConfirmed.reason, "ticket_unbillable");
assert.equal(testUnbillableConfirmed.userAction, null);
assert.match(testUnbillableConfirmed.statusMessage, /Folio no encontrado/);

const testUnbillableUnconfirmed = buildUserActionRequiredResult({
  reason: "ticket_validation_rejected",
  statusMessage: "Folio no encontrado",
  job: { ocrReviewConfirmed: false },
});

assert.equal(testUnbillableUnconfirmed.status, "needs_user_action");
assert.equal(testUnbillableUnconfirmed.reason, "ticket_data_rejected");
assert.ok(testUnbillableUnconfirmed.userAction !== null);

const testOcrReviewConfirmed = buildUserActionRequiredResult({
  reason: "ocr_review_required",
  statusMessage: "Faltan campos mandatorios",
  job: { ocrReviewConfirmed: true },
});

assert.equal(testOcrReviewConfirmed.status, "failed");
assert.equal(testOcrReviewConfirmed.reason, "ticket_unbillable");
assert.equal(testOcrReviewConfirmed.userAction, null);
assert.match(testOcrReviewConfirmed.statusMessage, /Faltan campos mandatorios/);

const testOcrReviewUnconfirmed = buildUserActionRequiredResult({
  reason: "ocr_review_required",
  statusMessage: "Faltan campos mandatorios",
  job: { ocrReviewConfirmed: false },
});

assert.equal(testOcrReviewUnconfirmed.status, "needs_user_action");
assert.equal(testOcrReviewUnconfirmed.reason, "ocr_review_required");
assert.ok(testOcrReviewUnconfirmed.userAction !== null);

console.log("buildUserActionRequiredResult loop mitigation unit tests passed!");
