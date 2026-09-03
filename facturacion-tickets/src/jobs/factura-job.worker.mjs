import {
  getWorkerCommandBatchSize,
  getWorkerHeartbeatIntervalMs,
  getWorkerConcurrency,
  getWorkerLane,
  getWorkerLeaseDurationMs,
  getWorkerMaxAttempts,
  getWorkerRetryBaseMs,
  getWorkerRetryMaxMs,
} from "../config/env.mjs";
import { runBillingOrchestrator } from "../orchestrator/billing-orchestrator.mjs";
import { CfdiValidationError } from "../cfdi/cfdi-validator.mjs";
import { logger } from "../shared/logger.mjs";
import { runCapaCInteractiveResume } from "../user-action/capa-c-resume.service.mjs";
import { JobClaimLostError, isJobClaimLostError } from "./job-claim.error.mjs";
import {
  deriveWorkflowStageAfterResult,
  normalizeWorkerLane,
  resolveJobWorkerLane,
} from "./job-workflow.mjs";

const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5000);

export async function runFacturaJobWorkerOnce(store, options = {}) {
  const workerLane = normalizeWorkerLane(options.lane ?? getWorkerLane());
  const processedCommands = options.processCommands === false
    ? []
    : await processClientCommandBatch(store);

  if (processedCommands.length) {
    logger.info("Billing client command batch handled.", {
      count: processedCommands.length,
      commandIds: processedCommands.map((command) => command.commandId),
    });

    for (const command of processedCommands) {
      await notifyWorkerCallback(options.onCommandProcessed, command, "command dispatch");
    }
  }

  if (options.commandOnly === true) {
    return processedCommands.length > 0;
  }

  const job = options.job ?? await resolveRequestedJob(store, options, workerLane);

  if (!job) {
    return processedCommands.length > 0;
  }

  logger.info("Factura job picked.", {
    jobId: job.id,
    workerLane,
    jobLane: resolveJobWorkerLane(job),
  });
  const claimedJob = await store.claimJob(job, { lane: workerLane });

  if (!claimedJob) {
    logger.info("Factura job already claimed by another worker.", { jobId: job.id });
    return true;
  }

  logger.info("Factura job claimed.", {
    jobId: claimedJob.id,
    claimedBy: claimedJob.claimedBy ?? null,
    claimId: claimedJob.claimId ?? null,
    leaseVersion: claimedJob.leaseVersion ?? null,
    attemptCount: claimedJob.attemptCount ?? null,
    workerLane,
    workflowStage: claimedJob.workflowStage ?? null,
  });

  const heartbeat = startJobLeaseHeartbeat(store, claimedJob);

  try {
    const result =
      ["capa_c_resume_requested", "capa_c_preparing"].includes(claimedJob.requestedStatus)
        ? await runCapaCInteractiveResume(claimedJob, {
            signal: heartbeat.signal,
            assertClaimActive: heartbeat.assertActive,
            onEvent: (event) => recordJobEvent(store, claimedJob, {
              ...event,
              attemptCount: claimedJob.attemptCount ?? null,
              workerId: claimedJob.claimedBy ?? null,
            }),
          })
        : await runBillingOrchestrator(claimedJob, {
            signal: heartbeat.signal,
            assertClaimActive: heartbeat.assertActive,
            allowPortalProbe: workerLane !== "ocr",
            stopAfterOcr: workerLane === "ocr",
            workerLane,
            onEvent: (event) => recordJobEvent(store, claimedJob, {
              ...event,
              attemptCount: claimedJob.attemptCount ?? null,
              workerId: claimedJob.claimedBy ?? null,
            }),
          });

    assertCompletedCfdiIsValidated(result);
    const retryScheduled = result.status === "retry_scheduled";
    await heartbeat.stop();

    if (heartbeat.hasLostClaim()) {
      logger.warn("Factura job result discarded because its claim was lost.", {
        jobId: claimedJob.id,
        claimId: claimedJob.claimId,
      });
      return true;
    }

    await updateOwnedJob(store, claimedJob, {
      ...result,
      workflowStage: deriveWorkflowStageAfterResult(claimedJob, result),
      claimedBy: null,
      claimId: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      retryAt: retryScheduled ? result.retryAt ?? new Date(Date.now() + getRetryDelayMs(claimedJob.attemptCount ?? 1)) : null,
      lastError: retryScheduled ? result.error ?? result.statusMessage ?? null : null,
    });
    await appendReleasedJobEvent(store, claimedJob, {
      type: result.status,
      status: result.status,
      message: result.statusMessage,
      actor: "worker",
      workerId: claimedJob.claimedBy ?? null,
      attemptCount: claimedJob.attemptCount ?? null,
      metadata: {
        workerLane,
        workflowStage: deriveWorkflowStageAfterResult(claimedJob, result),
        portalTemplateId: result.portalTemplateId ?? null,
        resultXmlStoragePath: result.resultXmlStoragePath ?? null,
        resultPdfStoragePath: result.resultPdfStoragePath ?? null,
        retryAt: retryScheduled ? result.retryAt ?? null : null,
        reason: result.reason ?? null,
      },
    });
    await notifyWorkerCallback(options.onJobReleased, {
      job: claimedJob,
      result: {
        ...result,
        workflowStage: deriveWorkflowStageAfterResult(claimedJob, result),
        retryAt: retryScheduled ? result.retryAt ?? null : null,
      },
      workerLane,
    }, "job release dispatch");
    logger.info("Factura job finished.", { jobId: claimedJob.id, status: result.status });
  } catch (error) {
    await heartbeat.stop();

    if (heartbeat.hasLostClaim() || isJobClaimLostError(error)) {
      logger.warn("Factura worker stopped after losing ownership of the job.", {
        jobId: claimedJob.id,
        claimId: claimedJob.claimId,
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }

    try {
      const errorResult = await handleProcessingError(store, claimedJob, error);
      await notifyWorkerCallback(options.onJobReleased, {
        job: claimedJob,
        result: errorResult,
        workerLane,
      }, "job retry dispatch");
    } catch (handlingError) {
      if (isJobClaimLostError(handlingError)) {
        logger.warn("Factura error result discarded because ownership changed.", {
          jobId: claimedJob.id,
          claimId: claimedJob.claimId,
        });
        return true;
      }

      logger.error("Could not persist factura job failure; lease recovery will retry it.", {
        jobId: claimedJob.id,
        claimId: claimedJob.claimId,
        error: handlingError instanceof Error ? handlingError.message : String(handlingError),
      });
    }
  }

  return true;
}

export async function watchFacturaJobs(store, options = {}) {
  const workerLane = normalizeWorkerLane(options.lane ?? getWorkerLane());
  const concurrency = Math.max(1, Number(options.concurrency ?? getWorkerConcurrency()));
  const signal = options.signal ?? null;
  logger.info("Factura worker started.", { pollIntervalMs, workerLane, concurrency });

  await Promise.all(
    Array.from({ length: concurrency }, (_, index) =>
      runWorkerSlot(store, { workerLane, slot: index + 1, signal }),
    ),
  );
}

async function runWorkerSlot(store, { workerLane, slot, signal = null }) {
  const processCommands = slot === 1 && ["all", "ocr"].includes(workerLane);

  while (!signal?.aborted) {
    try {
      await runFacturaJobWorkerOnce(store, { lane: workerLane, processCommands });
    } catch (error) {
      logger.error("Factura worker iteration failed; polling will continue.", {
        workerLane,
        slot,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await sleep(pollIntervalMs, signal);
  }
}

async function processClientCommandBatch(store) {
  if (store.processClientCommands) {
    return store.processClientCommands({ limit: getWorkerCommandBatchSize() });
  }

  if (store.processNextClientCommand) {
    const command = await store.processNextClientCommand();
    return command ? [command] : [];
  }

  return [];
}

async function resolveRequestedJob(store, options, workerLane) {
  if (options.jobIdentity) {
    if (!store.getJobByIdentity) {
      throw new Error("The selected job store cannot resolve queued job identities.");
    }

    return store.getJobByIdentity(options.jobIdentity);
  }

  return store.findPendingJob({ lane: workerLane });
}

function sleep(ms, signal = null) {
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

async function handleProcessingError(store, job, error) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const attemptCount = Number(job.attemptCount ?? 1);
  const maxAttempts = getWorkerMaxAttempts();

  if (attemptCount < maxAttempts) {
    const retryDelayMs = getRetryDelayMs(attemptCount);
    const retryAt = new Date(Date.now() + retryDelayMs);

    await updateOwnedJob(store, job, {
      status: "retry_scheduled",
      workflowStage: job.workflowStage ?? resolveJobWorkerLane(job),
      statusMessage: `Reintento programado en ${formatDelay(retryDelayMs)}`,
      error: errorMessage,
      lastError: errorMessage,
      retryAt,
      claimedBy: null,
      claimId: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
    });
    await appendReleasedJobEvent(store, job, {
      type: "retry_scheduled",
      status: "retry_scheduled",
      message: `Reintento programado en ${formatDelay(retryDelayMs)}`,
      actor: "worker",
      workerId: job.claimedBy ?? null,
      attemptCount,
      metadata: {
        maxAttempts,
        retryAt: retryAt.toISOString(),
        error: errorMessage,
      },
    });

    logger.warn("Factura job retry scheduled.", {
      jobId: job.id,
      attemptCount,
      maxAttempts,
      retryAt: retryAt.toISOString(),
      error: errorMessage,
    });
    return {
      status: "retry_scheduled",
      workflowStage: job.workflowStage ?? resolveJobWorkerLane(job),
      statusMessage: `Reintento programado en ${formatDelay(retryDelayMs)}`,
      error: errorMessage,
      retryAt,
    };
  }

  await updateOwnedJob(store, job, {
    status: "failed",
    workflowStage: job.workflowStage ?? resolveJobWorkerLane(job),
    statusMessage: "El procesamiento fallo",
    error: errorMessage,
    lastError: errorMessage,
    retryAt: null,
    claimedBy: null,
    claimId: null,
    heartbeatAt: null,
    leaseExpiresAt: null,
  });
  await appendReleasedJobEvent(store, job, {
    type: "failed",
    status: "failed",
    message: "El procesamiento fallo",
    actor: "worker",
    workerId: job.claimedBy ?? null,
    attemptCount,
    metadata: { error: errorMessage },
  });
  logger.error("Factura job failed.", { jobId: job.id, attemptCount, error: errorMessage });
  return {
    status: "failed",
    workflowStage: job.workflowStage ?? resolveJobWorkerLane(job),
    statusMessage: "El procesamiento fallo",
    error: errorMessage,
    retryAt: null,
  };
}

async function notifyWorkerCallback(callback, payload, label) {
  if (typeof callback !== "function") {
    return;
  }

  try {
    await callback(payload);
  } catch (error) {
    logger.warn(`Factura worker ${label} failed; Firestore remains authoritative.`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function getRetryDelayMs(attemptCount) {
  const baseMs = getWorkerRetryBaseMs();
  const maxMs = getWorkerRetryMaxMs();
  const multiplier = 2 ** Math.max(attemptCount - 1, 0);
  return Math.min(baseMs * multiplier, maxMs);
}

function assertCompletedCfdiIsValidated(result) {
  if (result?.status !== "completed" || result?.cfdiStorageMode !== "firebase") {
    return;
  }

  if (result.cfdiValidationResult?.ok !== true) {
    throw new CfdiValidationError(
      result.cfdiValidationResult ?? {
        ok: false,
        errors: ["CFDI validation result is missing"],
        warnings: [],
      },
    );
  }
}

function formatDelay(ms) {
  const seconds = Math.ceil(ms / 1000);

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.ceil(seconds / 60);
  return `${minutes}min`;
}

async function recordJobEvent(store, job, event) {
  if (!store.appendClaimedJobEvent && !store.appendJobEvent) {
    return;
  }

  try {
    const jobPatch = event.status === "portal_processing"
      ? {
        status: "portal_processing",
        statusMessage: event.message ?? "Generando factura en el portal",
      }
      : null;

    if (store.appendClaimedJobEvent) {
      await store.appendClaimedJobEvent(job, event, jobPatch);
      return;
    }

    await store.appendJobEvent(job.id, event);
    if (store.updateJob && jobPatch) {
      await store.updateJob(job.id, jobPatch);
    }
  } catch (error) {
    if (isJobClaimLostError(error)) {
      throw error;
    }

    logger.warn("Could not append factura job event.", {
      jobId: job.id,
      eventType: event.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function updateOwnedJob(store, job, patch) {
  if (store.updateClaimedJob) {
    return store.updateClaimedJob(job, patch);
  }

  return store.updateJob(job.id, patch);
}

async function appendReleasedJobEvent(store, job, event) {
  if (!store.appendJobEvent) {
    return;
  }

  try {
    await store.appendJobEvent(job.id, {
      ...event,
      metadata: {
        ...(event.metadata ?? {}),
        claimId: job.claimId ?? null,
        leaseVersion: job.leaseVersion ?? null,
      },
    });
  } catch (error) {
    logger.warn("Could not append terminal factura job event.", {
      jobId: job.id,
      eventType: event.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function startJobLeaseHeartbeat(store, job) {
  if (!store.renewLease) {
    return {
      signal: null,
      assertActive: async () => {},
      hasLostClaim: () => false,
      stop: async () => {},
    };
  }

  const leaseDurationMs = Math.max(3000, getWorkerLeaseDurationMs());
  const configuredIntervalMs = Math.max(1000, getWorkerHeartbeatIntervalMs());
  const intervalMs = Math.min(configuredIntervalMs, Math.max(1000, Math.floor(leaseDurationMs / 3)));
  let stopped = false;
  let claimLost = false;
  let inFlight = null;
  let lastSuccessfulRenewalAt = Date.now();
  const abortController = new AbortController();

  const markClaimLost = () => {
    claimLost = true;
    if (!abortController.signal.aborted) {
      abortController.abort(new JobClaimLostError(job.id));
    }
  };

  const renew = () => {
    if (stopped || claimLost || inFlight) {
      return;
    }

    inFlight = (async () => {
      try {
        const renewed = await store.renewLease(job);
        if (!renewed) {
          markClaimLost();
          return;
        }
        lastSuccessfulRenewalAt = Date.now();
      } catch (error) {
        if (isJobClaimLostError(error) || Date.now() - lastSuccessfulRenewalAt >= leaseDurationMs) {
          markClaimLost();
        }
        logger.warn("Could not renew factura job lease.", {
          jobId: job.id,
          claimId: job.claimId,
          claimLost,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        inFlight = null;
      }
    })();
  };

  const timer = setInterval(renew, intervalMs);
  timer.unref?.();

  return {
    signal: abortController.signal,
    assertActive: async () => {
      if (inFlight) {
        await inFlight;
      }
      if (claimLost) {
        throw new JobClaimLostError(job.id, "El worker perdio el claim antes de emitir");
      }

      const renewed = await store.renewLease(job);
      if (!renewed) {
        markClaimLost();
        throw new JobClaimLostError(job.id, "El worker perdio el claim antes de emitir");
      }
      lastSuccessfulRenewalAt = Date.now();
    },
    hasLostClaim: () => claimLost,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      if (inFlight) {
        await inFlight;
      }
    },
  };
}
