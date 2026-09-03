process.env.BILLING_DISPATCH_MODE = "hybrid";
process.env.BILLING_QUEUE_PREFIX = `easysat:test:queue:${Date.now()}:${process.pid}`;
process.env.BILLING_QUEUE_ATTEMPTS = "2";
process.env.BILLING_QUEUE_BACKOFF_MS = "100";

const {
  closeBillingQueueClients,
  createBillingSignalWorker,
  dispatchBillingCommandSignal,
  dispatchBillingJobSignal,
  inspectBillingQueueTelemetry,
  inspectBillingQueues,
  obliterateBillingQueues,
} = await import("../queue/billing-queue.mjs");

const seen = { ocr: [], portal: [] };
const targetedIdentities = [];
const fallbackClaims = [];
let infrastructureAttempts = 0;
let ocrWorker;
let portalWorker;

try {
  const first = await dispatchBillingJobSignal({
    uid: "queue_test_user",
    jobId: "queue_test_job",
    lane: "ocr",
    generation: "created",
  });
  const duplicate = await dispatchBillingJobSignal({
    uid: "queue_test_user",
    jobId: "queue_test_job",
    lane: "ocr",
    generation: "created",
  });
  const command = await dispatchBillingCommandSignal({
    uid: "queue_test_user",
    commandId: "queue_test_command",
    jobId: "queue_test_job",
  });
  const delayedStartedAt = Date.now();
  await dispatchBillingJobSignal({
    uid: "queue_test_user",
    jobId: "queue_test_portal_job",
    lane: "portal",
    generation: "retry-1",
    delayMs: 450,
  });
  await dispatchBillingJobSignal({
    uid: "queue_test_user",
    jobId: "queue_retry_job",
    lane: "portal",
    generation: "infrastructure-retry",
  });

  assert(first.id === duplicate.id, "duplicate dispatch must reuse the same BullMQ job id");
  assert(command.lane === "ocr", "client commands must be routed to the OCR queue");

  ocrWorker = createBillingSignalWorker({
    lane: "ocr",
    concurrency: 2,
    processor: async (data) => {
      seen.ocr.push({ kind: data.kind, id: data.jobId ?? data.commandId });
    },
  });
  portalWorker = createBillingSignalWorker({
    lane: "portal",
    processor: async (data) => {
      if (data.jobId === "queue_retry_job") {
        infrastructureAttempts += 1;
        if (infrastructureAttempts === 1) {
          throw new Error("simulated_transient_queue_failure");
        }
      }
      seen.portal.push({ kind: data.kind, id: data.jobId, at: Date.now() });
    },
  });

  await Promise.all([ocrWorker.waitUntilReady(), portalWorker.waitUntilReady()]);
  const liveTelemetry = await inspectBillingQueueTelemetry();
  assert(liveTelemetry.lanes.ocr.workersCount >= 1, "OCR worker must be visible to queue telemetry");
  assert(liveTelemetry.lanes.portal.workersCount >= 1, "portal worker must be visible to queue telemetry");

  await waitUntil(() => seen.ocr.length === 2 && seen.portal.length === 2, 10000);

  const duplicateJobSignals = seen.ocr.filter(
    (entry) => entry.kind === "billing_job" && entry.id === "queue_test_job",
  );
  assert(duplicateJobSignals.length === 1, "duplicate job signal must be processed once");
  assert(
    seen.portal.find((entry) => entry.id === "queue_test_portal_job").at - delayedStartedAt >= 350,
    "delayed signal must not run immediately",
  );
  assert(infrastructureAttempts === 2, "transient BullMQ failure must retry with backoff");

  await Promise.all([ocrWorker.close(), portalWorker.close()]);
  ocrWorker = null;
  portalWorker = null;

  const { watchBillingJobTransport } = await import("../queue/billing-queue-runtime.mjs");
  const shutdown = new AbortController();
  const runtimeStore = {
    getJobByIdentity: async (identity) => {
      targetedIdentities.push(identity);
      return {
        id: identity.jobId,
        uid: identity.uid,
        status: "pending",
        workflowStage: "portal",
        ocrReviewConfirmed: true,
      };
    },
    findPendingJob: async () => ({
      id: "queue_fallback_job",
      uid: "queue_fallback_user",
      status: "pending",
      workflowStage: "portal",
      ocrReviewConfirmed: true,
    }),
    claimJob: async (job) => {
      fallbackClaims.push(job.id);
      return null;
    },
  };
  const runtimePromise = watchBillingJobTransport(runtimeStore, {
    lane: "portal",
    concurrency: 1,
    signal: shutdown.signal,
  });
  await dispatchBillingJobSignal({
    uid: "queue_target_user",
    jobId: "queue_target_job",
    lane: "portal",
    generation: "runtime-target",
  });
  await waitUntil(() => targetedIdentities.length === 1, 10000);
  shutdown.abort("validation_complete");
  await runtimePromise;
  assert(
    targetedIdentities[0].uid === "queue_target_user" &&
      targetedIdentities[0].jobId === "queue_target_job",
    "queue runtime must resolve the exact Firestore identity from the signal",
  );
  assert(
    fallbackClaims.includes("queue_fallback_job"),
    "hybrid reconciliation must recover a pending Firestore job without a queue signal",
  );

  const queues = await inspectBillingQueues();
  console.log(JSON.stringify({
    ok: true,
    idempotentSignal: true,
    laneIsolation: true,
    commandWakeup: true,
    delayedRetrySignal: true,
    infrastructureRetry: true,
    workerTelemetry: true,
    firestoreTargeting: true,
    lostSignalReconciliation: true,
    seen,
    targetedIdentities,
    queues,
  }, null, 2));
} finally {
  await Promise.allSettled([ocrWorker?.close(), portalWorker?.close()].filter(Boolean));
  await obliterateBillingQueues().catch(() => {});
  await closeBillingQueueClients();
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for BullMQ validation signals.");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
