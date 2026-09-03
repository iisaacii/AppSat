import assert from "node:assert/strict";
import {
  buildQueueHealthFailure,
  evaluateBillingQueueHealth,
  getQueueHealthFingerprint,
} from "../monitoring/billing-queue-health.mjs";

const thresholds = {
  warningWaiting: 2,
  criticalWaiting: 5,
  warningOldestMs: 1000,
  criticalOldestMs: 5000,
  warningActiveMs: 10000,
  criticalActiveMs: 20000,
  warningDelayedOverdueMs: 500,
  criticalDelayedOverdueMs: 2000,
  failureWindowMs: 60000,
  warningFailures: 2,
  criticalFailures: 4,
};

const healthy = evaluateBillingQueueHealth(buildTelemetry(), {
  requireWorkers: true,
  thresholds,
});
assert.equal(healthy.status, "healthy");
assert.equal(healthy.totals.workers, 3);

const backlog = buildTelemetry();
backlog.lanes.ocr.counts.waiting = 2;
backlog.lanes.ocr.oldestWaitingAgeMs = 1500;
const warning = evaluateBillingQueueHealth(backlog, { requireWorkers: true, thresholds });
assert.equal(warning.status, "warning");
assert.ok(warning.alerts.some((alert) => alert.code === "queue_backlog_warning"));
assert.ok(warning.alerts.some((alert) => alert.code === "oldest_waiting_warning"));

const missingWorker = buildTelemetry();
missingWorker.lanes.portal.workersCount = 0;
const critical = evaluateBillingQueueHealth(missingWorker, { requireWorkers: true, thresholds });
assert.equal(critical.status, "critical");
assert.ok(critical.alerts.some((alert) => alert.code === "worker_missing"));

const idleWithoutRequiredWorker = buildTelemetry();
idleWithoutRequiredWorker.lanes.capa_c.workersCount = 0;
const optionalWorker = evaluateBillingQueueHealth(idleWithoutRequiredWorker, {
  requireWorkers: false,
  thresholds,
});
assert.equal(optionalWorker.status, "healthy");

const startupBacklog = buildTelemetry();
startupBacklog.lanes.ocr.workersCount = 0;
startupBacklog.lanes.ocr.counts.waiting = 1;
const startupGrace = evaluateBillingQueueHealth(startupBacklog, {
  requireWorkers: false,
  suppressMissingWorkers: true,
  thresholds,
});
assert.equal(startupGrace.status, "healthy");

const dueRetry = buildTelemetry();
dueRetry.lanes.portal.delayedOverdueMs = 2500;
const delayedCritical = evaluateBillingQueueHealth(dueRetry, { requireWorkers: true, thresholds });
assert.ok(delayedCritical.alerts.some((alert) => alert.code === "delayed_job_stalled"));

const failures = buildTelemetry();
failures.lanes.ocr.recentFailures = 4;
failures.lanes.ocr.latestFailure = { reason: "Vision unavailable" };
const failureCritical = evaluateBillingQueueHealth(failures, { requireWorkers: true, thresholds });
assert.ok(failureCritical.alerts.some((alert) => alert.code === "recent_failures_critical"));

const backendFailure = buildQueueHealthFailure(new Error("ECONNREFUSED redis"));
assert.equal(backendFailure.status, "critical");
assert.match(backendFailure.alerts[0].details, /ECONNREFUSED/);
assert.notEqual(getQueueHealthFingerprint(healthy), getQueueHealthFingerprint(critical));

console.log(JSON.stringify({
  ok: true,
  healthy: healthy.status,
  warningCodes: warning.alerts.map((alert) => alert.code),
  criticalCodes: critical.alerts.map((alert) => alert.code),
  delayedCode: delayedCritical.alerts[0].code,
  backendFailure: backendFailure.alerts[0].code,
}, null, 2));

function buildTelemetry() {
  return {
    capturedAt: "2026-08-28T00:00:00.000Z",
    redisLatencyMs: 3,
    failureWindowMs: 60000,
    lanes: {
      ocr: lane(),
      portal: lane(),
      capa_c: lane(),
    },
  };
}

function lane() {
  return {
    name: "billing-test",
    counts: {
      waiting: 0,
      active: 0,
      delayed: 0,
      completed: 0,
      failed: 0,
      paused: 0,
    },
    workersCount: 1,
    oldestWaitingAgeMs: null,
    oldestActiveAgeMs: null,
    delayedDueInMs: null,
    delayedOverdueMs: null,
    recentFailures: 0,
    latestFailure: null,
  };
}
