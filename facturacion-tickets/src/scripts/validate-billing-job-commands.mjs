import assert from "node:assert/strict";
import {
  BILLING_JOB_COMMAND_VERSION,
  buildBillingJobCommandTransition,
  validateBillingJobCommand,
} from "../jobs/billing-job-command.service.mjs";

const uid = "command_test_user";
const timestamp = "SERVER_TIMESTAMP";
const baseJob = {
  id: "job_001",
  uid,
  status: "needs_user_action",
  reason: "ocr_review_required",
};

const confirmation = command("confirm_ocr", {
  correction: {
    rfcEmisor: "ocs120223sn2",
    fecha: "2026-05-17",
    monto: "100.00",
    folio: "20242",
    ignored: "must not pass",
  },
});
assert.deepEqual(validateBillingJobCommand(confirmation, { uid }), []);

const confirmed = buildBillingJobCommandTransition({
  job: baseJob,
  command: confirmation,
  uid,
  serverTimestamp: timestamp,
});
assert.equal(confirmed.ok, true);
assert.equal(confirmed.patch.status, "pending");
assert.equal(confirmed.patch.rfcEmisor, "OCS120223SN2");
assert.equal(confirmed.patch.monto, 100);
assert.equal(confirmed.patch.portalFinalSubmitApproved, true);
assert.equal(confirmed.patch.workflowStage, "portal");
assert.equal(confirmed.patch.ignored, undefined);
assert.equal(confirmed.patch.claimedBy, null);

const ticketId = buildBillingJobCommandTransition({
  job: baseJob,
  command: command("apply_ticket_id", { ticketId: " abc-123 " }),
  uid,
  serverTimestamp: timestamp,
});
assert.equal(ticketId.ok, true);
assert.equal(ticketId.patch["ocrCandidates.ticketId"], "ABC-123");

const capaC = buildBillingJobCommandTransition({
  job: {
    ...baseJob,
    reason: "captcha_required",
    userAction: { reason: "captcha_required" },
  },
  command: command("request_capa_c_resume", {}),
  uid,
  serverTimestamp: timestamp,
});
assert.equal(capaC.ok, true);
assert.equal(capaC.patch.status, "capa_c_resume_requested");
assert.equal(capaC.patch.workflowStage, "capa_c");
assert.equal(capaC.patch.attemptCount, 0);

const invalidCapaC = buildBillingJobCommandTransition({
  job: { ...baseJob, userAction: { reason: "ticket_expired" } },
  command: command("request_capa_c_resume", {}),
  uid,
  serverTimestamp: timestamp,
});
assert.equal(invalidCapaC.ok, false);
assert.equal(invalidCapaC.reason, "unsupported_user_action");

const completed = buildBillingJobCommandTransition({
  job: { ...baseJob, status: "completed" },
  command: confirmation,
  uid,
  serverTimestamp: timestamp,
});
assert.equal(completed.ok, false);
assert.equal(completed.reason, "job_already_terminal");

const forged = buildBillingJobCommandTransition({
  job: baseJob,
  command: { ...confirmation, requestedBy: "attacker" },
  uid,
  serverTimestamp: timestamp,
});
assert.equal(forged.ok, false);
assert.equal(forged.reason, "invalid_command");

console.log(
  JSON.stringify(
    {
      ok: true,
      version: BILLING_JOB_COMMAND_VERSION,
      transitions: [
        "confirm_ocr",
        "apply_ticket_id",
        "approve_final_submit",
        "request_capa_c_resume",
      ],
    },
    null,
    2,
  ),
);

function command(type, payload) {
  return {
    version: BILLING_JOB_COMMAND_VERSION,
    clientRequestId: `command_${type}`,
    uid,
    jobId: baseJob.id,
    type,
    payload,
    status: "pending",
    requestedBy: uid,
    requestedAt: "now",
  };
}
