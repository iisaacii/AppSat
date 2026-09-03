import assert from "node:assert/strict";
import {
  WORKER_LANES,
  WORKFLOW_STAGES,
  buildClaimPresentation,
  deriveWorkflowStageAfterResult,
  isJobEligibleForWorkerLane,
  resolveJobWorkerLane,
} from "../jobs/job-workflow.mjs";
import {
  OCR_CHECKPOINT_VERSION,
  buildOcrCheckpoint,
  readReusableOcrCheckpoint,
} from "../orchestrator/ocr-checkpoint.mjs";
import { runFacturaJobWorkerOnce, watchFacturaJobs } from "../jobs/factura-job.worker.mjs";

const ticketFileUrl = "https://firebasestorage.googleapis.com/v0/b/appsat-dev.firebasestorage.app/o/billing-lab%2Ftickets%2Fuser_1%2Fticket.jpg?alt=media";
const initialJob = {
  id: "job_initial",
  status: "pending",
  ocrReviewConfirmed: false,
  ticketFileUrl,
};
const portalJob = {
  ...initialJob,
  id: "job_portal",
  ocrReviewConfirmed: true,
  workflowStage: WORKFLOW_STAGES.PORTAL,
};
const capaCJob = {
  ...portalJob,
  id: "job_capa_c",
  status: "capa_c_resume_requested",
  workflowStage: WORKFLOW_STAGES.CAPA_C,
};

assert.equal(resolveJobWorkerLane(initialJob), WORKER_LANES.OCR);
assert.equal(resolveJobWorkerLane(portalJob), WORKER_LANES.PORTAL);
assert.equal(resolveJobWorkerLane(capaCJob), WORKER_LANES.CAPA_C);
assert.equal(isJobEligibleForWorkerLane(portalJob, WORKER_LANES.OCR), false);
assert.equal(isJobEligibleForWorkerLane(portalJob, WORKER_LANES.PORTAL), true);
assert.equal(buildClaimPresentation(portalJob).status, "portal_processing");
assert.equal(buildClaimPresentation(initialJob).status, "ocr_processing");
assert.equal(
  deriveWorkflowStageAfterResult(portalJob, {
    status: "needs_user_action",
    reason: "ocr_review_required",
  }),
  WORKFLOW_STAGES.AWAITING_OCR_CONFIRMATION,
);
assert.equal(
  deriveWorkflowStageAfterResult(portalJob, { status: "completed" }),
  WORKFLOW_STAGES.COMPLETE,
);

const extraction = {
  rfcEmisor: "OCS120223SN2",
  fecha: "2026-05-17",
  monto: 100,
  ocrEngine: "google_vision",
  ocrText: "TOTAL 100.00",
  ocrCandidates: { folioVenta: "20242" },
  portalDiscovery: { selectedUrl: "https://www.tierragarat.mx" },
};
const checkpoint = buildOcrCheckpoint({ job: portalJob, extracted: extraction });
assert.equal(checkpoint.version, OCR_CHECKPOINT_VERSION);
assert.deepEqual(
  readReusableOcrCheckpoint({ ...portalJob, ocrCheckpoint: checkpoint }),
  extraction,
);
assert.equal(
  readReusableOcrCheckpoint({ ...initialJob, ocrCheckpoint: checkpoint }),
  null,
  "OCR no confirmado nunca debe saltarse",
);
assert.equal(
  readReusableOcrCheckpoint({
    ...portalJob,
    ticketFileUrl: `${ticketFileUrl}&different=true`,
    ocrCheckpoint: checkpoint,
  }),
  null,
  "Un checkpoint no se reutiliza para otra imagen",
);

let commandBatchCalls = 0;
let commandBatchLimit = null;
const dispatchedCommands = [];
const commandOnlyStore = {
  processClientCommands: async ({ limit }) => {
    commandBatchCalls += 1;
    commandBatchLimit = limit;
    return [{
      commandId: "command_1",
      jobId: "job_portal",
      uid: "user_1",
      status: "processed",
      workflowStage: WORKFLOW_STAGES.PORTAL,
    }];
  },
  findPendingJob: async () => null,
};
assert.equal(
  await runFacturaJobWorkerOnce(commandOnlyStore, {
    lane: WORKER_LANES.OCR,
    onCommandProcessed: async (command) => dispatchedCommands.push(command),
  }),
  true,
);
assert.equal(commandBatchCalls, 1);
assert.equal(dispatchedCommands[0].workflowStage, WORKFLOW_STAGES.PORTAL);

let scannedForAnyJob = false;
const queuedIdentityStore = {
  getJobByIdentity: async ({ uid, jobId }) => ({ ...portalJob, uid, id: jobId }),
  findPendingJob: async () => {
    scannedForAnyJob = true;
    return null;
  },
  claimJob: async () => null,
};
assert.equal(
  await runFacturaJobWorkerOnce(queuedIdentityStore, {
    lane: WORKER_LANES.PORTAL,
    processCommands: false,
    jobIdentity: { uid: "user_1", jobId: "job_portal" },
  }),
  true,
);
assert.equal(scannedForAnyJob, false, "Una senal BullMQ debe resolver el job indicado, no otro job");
assert.equal(commandBatchLimit, 10);
assert.equal(
  await runFacturaJobWorkerOnce(commandOnlyStore, {
    lane: WORKER_LANES.PORTAL,
    processCommands: false,
  }),
  false,
);
assert.equal(commandBatchCalls, 1);

const shutdown = new AbortController();
const shutdownStartedAt = Date.now();
const idleStore = {
  processClientCommands: async () => [],
  findPendingJob: async () => null,
};
const watchPromise = watchFacturaJobs(idleStore, {
  lane: WORKER_LANES.OCR,
  concurrency: 2,
  signal: shutdown.signal,
});
setTimeout(() => shutdown.abort("validation_complete"), 25);
await watchPromise;
const gracefulShutdownMs = Date.now() - shutdownStartedAt;
assert.ok(gracefulShutdownMs < 1000, `Worker shutdown took ${gracefulShutdownMs}ms`);

console.log(
  JSON.stringify(
    {
      ok: true,
      lanes: Object.values(WORKER_LANES),
      checkpointVersion: OCR_CHECKPOINT_VERSION,
      confirmedOcrIsReusable: true,
      commandBatchSize: commandBatchLimit,
      queuedIdentityTargetsExactJob: true,
      commandProcessorSlots: "all/ocr slot 1",
      gracefulShutdownMs,
    },
    null,
    2,
  ),
);
