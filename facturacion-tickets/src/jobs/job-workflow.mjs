export const WORKER_LANES = Object.freeze({
  ALL: "all",
  OCR: "ocr",
  PORTAL: "portal",
  CAPA_C: "capa_c",
});

export const WORKFLOW_STAGES = Object.freeze({
  OCR: "ocr",
  AWAITING_OCR_CONFIRMATION: "awaiting_ocr_confirmation",
  PORTAL: "portal",
  CAPA_C: "capa_c",
  MANUAL: "manual",
  COMPLETE: "complete",
});

const validWorkerLanes = new Set(Object.values(WORKER_LANES));

export function normalizeWorkerLane(value) {
  const normalized = String(value ?? WORKER_LANES.ALL).trim().toLowerCase();

  if (!validWorkerLanes.has(normalized)) {
    throw new Error(`Unsupported WORKER_LANE: ${value}`);
  }

  return normalized;
}

export function resolveJobWorkerLane(job = {}) {
  const status = clean(job.status);
  const stage = clean(job.workflowStage);

  if (
    status === "capa_c_resume_requested" ||
    status === "capa_c_preparing" ||
    stage === WORKFLOW_STAGES.CAPA_C
  ) {
    return WORKER_LANES.CAPA_C;
  }

  if (status === "portal_processing" || stage === WORKFLOW_STAGES.PORTAL) {
    return WORKER_LANES.PORTAL;
  }

  if (status === "ocr_processing" || stage === WORKFLOW_STAGES.OCR) {
    return WORKER_LANES.OCR;
  }

  // Jobs created before workflowStage existed are inferred from the immutable
  // OCR confirmation applied by the command processor.
  if (job.ocrReviewConfirmed === true || job.ocrReview?.status === "confirmed") {
    return WORKER_LANES.PORTAL;
  }

  return WORKER_LANES.OCR;
}

export function isJobEligibleForWorkerLane(job, workerLane = WORKER_LANES.ALL) {
  const normalizedLane = normalizeWorkerLane(workerLane);
  return normalizedLane === WORKER_LANES.ALL || resolveJobWorkerLane(job) === normalizedLane;
}

export function buildClaimPresentation(job, workerLane = WORKER_LANES.ALL) {
  const lane = workerLane === WORKER_LANES.ALL
    ? resolveJobWorkerLane(job)
    : normalizeWorkerLane(workerLane);

  switch (lane) {
    case WORKER_LANES.PORTAL:
      return {
        lane,
        workflowStage: WORKFLOW_STAGES.PORTAL,
        status: "portal_processing",
        statusMessage: "Generando factura",
      };
    case WORKER_LANES.CAPA_C:
      return {
        lane,
        workflowStage: WORKFLOW_STAGES.CAPA_C,
        status: "capa_c_preparing",
        statusMessage: "Preparando portal asistido",
      };
    default:
      return {
        lane: WORKER_LANES.OCR,
        workflowStage: WORKFLOW_STAGES.OCR,
        status: "ocr_processing",
        statusMessage: "Analizando ticket",
      };
  }
}

export function deriveWorkflowStageAfterResult(job, result = {}) {
  const status = clean(result.status);
  const reason = clean(result.reason ?? result.userAction?.reason);
  const explicitStage = clean(result.workflowStage);

  if (Object.values(WORKFLOW_STAGES).includes(explicitStage)) {
    return explicitStage;
  }

  if (reason === "ocr_review_required" || status === "ocr_review_required") {
    return WORKFLOW_STAGES.AWAITING_OCR_CONFIRMATION;
  }

  if (["completed", "resolved", "cancelled"].includes(status)) {
    return WORKFLOW_STAGES.COMPLETE;
  }

  if (status === "needs_user_action" || status === "fallback_required") {
    return WORKFLOW_STAGES.MANUAL;
  }

  if (status === "retry_scheduled" || status === "failed") {
    return buildClaimPresentation(job).workflowStage;
  }

  return buildClaimPresentation(job).workflowStage;
}

function clean(value) {
  return String(value ?? "").trim().toLowerCase();
}
