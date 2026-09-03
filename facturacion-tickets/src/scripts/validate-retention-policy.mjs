import assert from "node:assert/strict";
import {
  RETENTION_ACTIONS,
  buildExpiredJobPatch,
  evaluateBillingCommandRetention,
  evaluateJobRetention,
  evaluateStorageObjectRetention,
  evaluateTemplateCandidateRetention,
} from "../maintenance/retention-policy.mjs";

const now = new Date("2026-08-27T12:00:00.000Z");
const daysAgo = (days) => new Date(now.getTime() - days * 86400000).toISOString();

assert.equal(
  evaluateJobRetention({ status: "ocr_review_required", updatedAt: daysAgo(6) }, { now }).action,
  RETENTION_ACTIONS.EXPIRE_JOB,
);
assert.equal(
  evaluateJobRetention({ status: "needs_user_action", updatedAt: daysAgo(5) }, { now }).action,
  RETENTION_ACTIONS.EXPIRE_JOB,
);
assert.equal(
  evaluateJobRetention({ status: "portal_processing", updatedAt: daysAgo(20) }, { now }).reason,
  "lease_recovery_owns_processing_job",
);
assert.equal(
  evaluateJobRetention({ status: "completed", updatedAt: daysAgo(400) }, { now }).action,
  RETENTION_ACTIONS.KEEP,
);
assert.equal(
  evaluateJobRetention(
    { status: "failed", updatedAt: daysAgo(100) },
    { now, purgeAbandonedJobs: true, abandonedPurgeDays: 90 },
  ).action,
  RETENTION_ACTIONS.PURGE_JOB,
);
assert.equal(
  evaluateJobRetention(
    { status: "failed", updatedAt: daysAgo(100) },
    { now, purgeAbandonedJobs: false, abandonedPurgeDays: 90 },
  ).action,
  RETENTION_ACTIONS.KEEP,
);

assert.equal(
  evaluateStorageObjectRetention(
    { name: "billing-lab/tickets/u1/j1.jpg", updatedAt: daysAgo(31) },
    { now },
  ).action,
  RETENTION_ACTIONS.DELETE_STORAGE_OBJECT,
);
assert.equal(
  evaluateStorageObjectRetention(
    { name: "billing-lab/portal-artifacts/u1/j1/screenshot.png", updatedAt: daysAgo(8) },
    { now },
  ).action,
  RETENTION_ACTIONS.DELETE_STORAGE_OBJECT,
);
assert.equal(
  evaluateStorageObjectRetention(
    { name: "billing-lab/cfdis/u1/j1/cfdi.xml", updatedAt: daysAgo(1000) },
    { now },
  ).reason,
  "cfdi_retained",
);
assert.equal(buildExpiredJobPatch({ now }).workflowStage, "complete");
assert.equal(buildExpiredJobPatch({ now }).status, "expired");
assert.equal(
  evaluateBillingCommandRetention({ status: "pending", requestedAt: daysAgo(6) }, { now }).action,
  RETENTION_ACTIONS.EXPIRE_COMMAND,
);
assert.equal(
  evaluateBillingCommandRetention(
    { status: "processed", processedAt: daysAgo(31) },
    { now },
  ).action,
  RETENTION_ACTIONS.DELETE_COMMAND,
);
assert.equal(
  evaluateTemplateCandidateRetention(
    { status: "degraded", sourceCreatedAt: daysAgo(46) },
    { now },
  ).action,
  RETENTION_ACTIONS.DELETE_REGISTRY_CANDIDATE,
);
assert.equal(
  evaluateTemplateCandidateRetention(
    { status: "active_lab", sourceCreatedAt: daysAgo(400) },
    { now },
  ).reason,
  "active_template_candidate",
);

console.log(
  JSON.stringify(
    {
      ok: true,
      actionableJobDays: 5,
      processingLeasePolicy: "keep_for_lease_recovery",
      abandonedPurgeDefault: false,
      ticketImageDays: 30,
      portalArtifactDays: 7,
      cfdiPolicy: "retain",
      commandDays: 30,
      inactiveTemplateDays: 45,
    },
    null,
    2,
  ),
);
