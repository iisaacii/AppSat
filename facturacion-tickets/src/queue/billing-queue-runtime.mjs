import {
  getBillingDispatchMode,
  getBillingQueueFallbackPollMs,
  getWorkerConcurrency,
  getWorkerLane,
} from "../config/env.mjs";
import { runFacturaJobWorkerOnce, watchFacturaJobs } from "../jobs/factura-job.worker.mjs";
import { normalizeWorkerLane, WORKER_LANES } from "../jobs/job-workflow.mjs";
import { logger } from "../shared/logger.mjs";
import {
  createBillingSignalWorker,
  dispatchBillingJobSignal,
} from "./billing-queue.mjs";

export async function watchBillingJobTransport(store, options = {}) {
  const mode = getBillingDispatchMode();

  if (mode === "poll") {
    return watchFacturaJobs(store, options);
  }

  const lane = normalizeConcreteLane(options.lane ?? getWorkerLane());
  const concurrency = Math.max(1, Number(options.concurrency ?? getWorkerConcurrency()));
  const signal = options.signal ?? null;
  const runtime = { active: 0 };
  const callbacks = buildDispatchCallbacks();
  const queueWorker = createBillingSignalWorker({
    lane,
    concurrency,
    processor: async (data) => {
      runtime.active += 1;
      try {
        return await processBillingSignal(store, lane, data, callbacks);
      } finally {
        runtime.active -= 1;
      }
    },
  });

  queueWorker.on("ready", () => {
    logger.info("BullMQ billing worker ready.", { lane, concurrency, mode });
  });
  queueWorker.on("failed", (job, error) => {
    logger.warn("BullMQ billing signal failed.", {
      lane,
      queueJobId: job?.id ?? null,
      signalKind: job?.data?.kind ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  queueWorker.on("error", (error) => {
    logger.error("BullMQ billing worker connection error.", {
      lane,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  logger.info("Factura worker transport started.", {
    mode,
    lane,
    concurrency,
    fallbackPollMs: mode === "hybrid" ? getBillingQueueFallbackPollMs() : null,
  });

  const fallback = mode === "hybrid"
    ? runFallbackLoop(store, { lane, signal, runtime, callbacks })
    : waitForAbort(signal);

  await waitForAbort(signal);
  await queueWorker.close();
  await fallback;
}

async function processBillingSignal(store, lane, data, callbacks) {
  if (data?.kind === "billing_command") {
    if (lane !== WORKER_LANES.OCR) {
      throw new Error("Billing commands can only be consumed by the OCR lane.");
    }

    const processed = await runFacturaJobWorkerOnce(store, {
      lane,
      processCommands: true,
      commandOnly: true,
      ...callbacks,
    });
    return { processed, kind: data.kind };
  }

  if (data?.kind !== "billing_job") {
    throw new Error(`Unsupported billing queue signal: ${data?.kind ?? "missing"}`);
  }

  if (normalizeConcreteLane(data.lane) !== lane) {
    throw new Error(`Billing signal lane mismatch: expected ${lane}, received ${data.lane}`);
  }

  const processed = await runFacturaJobWorkerOnce(store, {
    lane,
    processCommands: false,
    jobIdentity: {
      uid: clean(data.uid),
      jobId: clean(data.jobId),
    },
    ...callbacks,
  });

  return { processed, kind: data.kind, jobId: data.jobId };
}

function buildDispatchCallbacks() {
  return {
    onCommandProcessed: async (command) => {
      const lane = laneFromWorkflowStage(command.workflowStage);

      if (!lane || !command.uid || !command.jobId) {
        return;
      }

      await dispatchBillingJobSignal({
        uid: command.uid,
        jobId: command.jobId,
        lane,
        generation: `command-${command.commandId}`,
        reason: "client_command_processed",
      });
    },
    onJobReleased: async ({ job, result, workerLane }) => {
      const dispatch = buildReleasedJobDispatch({ job, result, workerLane });
      if (dispatch) await dispatchBillingJobSignal(dispatch);
    },
  };
}

export function buildReleasedJobDispatch({ job, result, workerLane, now = Date.now() } = {}) {
  if (!job?.uid || !job?.id) return null;
  const nextLane = laneFromWorkflowStage(result?.workflowStage);

  if (result?.status === "retry_scheduled") {
    const retryAtMs = toDateMs(result.retryAt);
    return {
      uid: job.uid,
      jobId: job.id,
      lane: nextLane ?? workerLane,
      generation: `retry-${job.attemptCount ?? 0}-${retryAtMs}`,
      delayMs: Math.max(0, retryAtMs - now),
      reason: "firestore_retry_scheduled",
    };
  }

  if (!nextLane || nextLane === workerLane || result?.status !== "pending") return null;
  return {
    uid: job.uid,
    jobId: job.id,
    lane: nextLane,
    generation: `stage-${nextLane}-${job.attemptCount ?? 0}`,
    reason: "workflow_stage_advanced",
  };
}

async function runFallbackLoop(store, { lane, signal, runtime, callbacks }) {
  const intervalMs = getBillingQueueFallbackPollMs();
  const processCommands = lane === WORKER_LANES.OCR;

  while (!signal?.aborted) {
    if (runtime.active < 1) {
      runtime.active += 1;
      try {
        await runFacturaJobWorkerOnce(store, {
          lane,
          processCommands,
          ...callbacks,
        });
      } catch (error) {
        logger.error("Billing queue reconciliation failed; it will retry.", {
          lane,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        runtime.active -= 1;
      }
    }

    await sleep(intervalMs, signal);
  }
}

function normalizeConcreteLane(value) {
  const lane = normalizeWorkerLane(value);

  if (lane === WORKER_LANES.ALL) {
    throw new Error("BullMQ transport requires a concrete worker lane.");
  }

  return lane;
}

function laneFromWorkflowStage(value) {
  switch (clean(value).toLowerCase()) {
    case "ocr":
      return WORKER_LANES.OCR;
    case "portal":
      return WORKER_LANES.PORTAL;
    case "capa_c":
      return WORKER_LANES.CAPA_C;
    default:
      return null;
  }
}

function waitForAbort(signal) {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    signal?.addEventListener("abort", resolve, { once: true });
  });
}

function sleep(ms, signal) {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });

    function finish() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function toDateMs(value) {
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value ?? Date.now()).getTime();
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function clean(value) {
  return String(value ?? "").trim();
}
