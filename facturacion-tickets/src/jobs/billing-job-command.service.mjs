export const BILLING_JOB_COMMAND_VERSION = "billing-job-command.v1";

export const BILLING_JOB_COMMAND_TYPES = Object.freeze([
  "confirm_ocr",
  "apply_ticket_id",
  "approve_final_submit",
  "request_capa_c_resume",
]);

const editableStatuses = new Set([
  "ocr_review_required",
  "needs_user_action",
  "failed",
  "retry_scheduled",
  "preview_ready",
]);
const terminalStatuses = new Set(["completed", "resolved", "cancelled"]);
const ticketStringFields = [
  "codigoFacturacion",
  "permisoCre",
  "estacionCodigo",
  "estacionNombre",
  "sucursal",
  "serie",
  "token",
  "terminal",
  "webId",
];

export function validateBillingJobCommand(command, { uid = null } = {}) {
  const errors = [];

  if (!command || typeof command !== "object" || Array.isArray(command)) {
    return ["command must be an object"];
  }

  if (command.version !== BILLING_JOB_COMMAND_VERSION) {
    errors.push(`version must be ${BILLING_JOB_COMMAND_VERSION}`);
  }
  if (!BILLING_JOB_COMMAND_TYPES.includes(command.type)) {
    errors.push("unsupported command type");
  }
  if (!clean(command.uid)) errors.push("missing uid");
  if (!clean(command.jobId)) errors.push("missing jobId");
  if (!clean(command.requestedBy)) errors.push("missing requestedBy");
  if (uid && (command.uid !== uid || command.requestedBy !== uid)) {
    errors.push("command owner mismatch");
  }
  if (command.status !== "pending") errors.push("status must be pending");
  if (!command.payload || typeof command.payload !== "object" || Array.isArray(command.payload)) {
    errors.push("payload must be an object");
  }

  return errors;
}

export function buildBillingJobCommandTransition({
  job,
  command,
  uid,
  serverTimestamp,
} = {}) {
  const validationErrors = validateBillingJobCommand(command, { uid });

  if (validationErrors.length) {
    return reject("invalid_command", validationErrors.join(", "));
  }
  if (!job) {
    return reject("job_not_found", "El job indicado no existe");
  }
  if (job.uid !== uid) {
    return reject("job_owner_mismatch", "El job no pertenece al usuario del comando");
  }
  if (terminalStatuses.has(job.status)) {
    return reject("job_already_terminal", `El job ya termino con estado ${job.status}`);
  }

  switch (command.type) {
    case "confirm_ocr":
      return buildConfirmOcrTransition({ job, command, uid, serverTimestamp });
    case "apply_ticket_id":
      return buildTicketIdTransition({ job, command, uid, serverTimestamp });
    case "approve_final_submit":
      return buildFinalSubmitTransition({ job, command, serverTimestamp });
    case "request_capa_c_resume":
      return buildCapaCResumeTransition({ job, command, serverTimestamp });
    default:
      return reject("unsupported_command", "Tipo de comando no soportado");
  }
}

function buildConfirmOcrTransition({ job, command, uid, serverTimestamp }) {
  if (!editableStatuses.has(job.status)) {
    return reject("invalid_job_state", `No se puede confirmar OCR desde ${job.status}`);
  }

  const correction = sanitizeCorrection(command.payload.correction);
  if (!Object.keys(correction).length) {
    return reject("empty_correction", "La confirmacion OCR no contiene datos validos");
  }

  const patch = buildReviewResetPatch({
    uid,
    serverTimestamp,
    statusMessage: "Datos OCR confirmados; listo para reprocesar",
  });
  applyCorrectionPatch(patch, correction, serverTimestamp);

  return accept({
    patch,
    event: {
      type: "manual_correction",
      status: "pending",
      message: "Datos OCR confirmados por el usuario",
      metadata: { fields: Object.keys(correction) },
    },
  });
}

function buildTicketIdTransition({ job, command, uid, serverTimestamp }) {
  if (!editableStatuses.has(job.status)) {
    return reject("invalid_job_state", `No se puede corregir el ticket desde ${job.status}`);
  }

  const ticketId = normalizeTicketValue(command.payload.ticketId).toUpperCase();
  if (!ticketId) {
    return reject("invalid_ticket_id", "El ID de ticket esta vacio o es invalido");
  }

  const patch = buildReviewResetPatch({
    uid,
    serverTimestamp,
    statusMessage: "ID de ticket confirmado; listo para reprocesar",
  });
  patch["ocrCandidates.ticketId"] = ticketId;
  patch["manualOverrides.ocrCandidates.ticketId"] = ticketId;

  return accept({
    patch,
    event: {
      type: "ticket_id_candidate_applied",
      status: "pending",
      message: "ID de ticket corregido desde candidato OCR",
      metadata: { ticketId },
    },
  });
}

function buildFinalSubmitTransition({ job, command, serverTimestamp }) {
  if (!editableStatuses.has(job.status)) {
    return reject("invalid_job_state", `No se puede aprobar la generacion desde ${job.status}`);
  }

  return accept({
    patch: {
      status: "pending",
      workflowStage: "portal",
      statusMessage: "Aprobacion final validada; listo para generar",
      portalFinalSubmitApproved: true,
      error: null,
      lastError: null,
      attemptCount: 0,
      claimedBy: null,
      claimId: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      retryAt: null,
      updatedAt: serverTimestamp,
    },
    event: {
      type: "final_submit_approved",
      status: "pending",
      message: "Generacion final aprobada por el usuario",
      metadata: {
        previousReason: clean(command.payload.previousReason) || null,
      },
    },
  });
}

function buildCapaCResumeTransition({ job, command, serverTimestamp }) {
  if (job.status !== "needs_user_action") {
    return reject("invalid_job_state", `No se puede preparar Capa C desde ${job.status}`);
  }

  const reason = clean(job.userAction?.reason ?? job.reason);
  const supportedReasons = new Set([
    "captcha_required",
    "login_required",
    "portal_blocked",
    "manual_portal_required",
  ]);
  if (!supportedReasons.has(reason)) {
    return reject("unsupported_user_action", `Capa C no soporta la razon ${reason || "desconocida"}`);
  }

  return accept({
    patch: {
      status: "capa_c_resume_requested",
      workflowStage: "capa_c",
      statusMessage: "Preparando portal asistido",
      error: null,
      lastError: null,
      claimedBy: null,
      claimId: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      retryAt: null,
      attemptCount: 0,
      "interactiveSession.status": "requested",
      "interactiveSession.requestedAt": serverTimestamp,
      "userAction.interactiveSession.status": "requested",
      "userAction.interactiveSession.requestedAt": serverTimestamp,
      updatedAt: serverTimestamp,
    },
    event: {
      type: "capa_c_resume_requested",
      status: "capa_c_resume_requested",
      message: "Portal asistido solicitado por el usuario",
      metadata: { reason },
    },
  });
}

function buildReviewResetPatch({ uid, serverTimestamp, statusMessage }) {
  return {
    status: "pending",
    workflowStage: "portal",
    statusMessage,
    error: null,
    lastError: null,
    attemptCount: 0,
    claimedBy: null,
    claimId: null,
    heartbeatAt: null,
    leaseExpiresAt: null,
    retryAt: null,
    missingFields: [],
    userAction: null,
    ocrReviewConfirmed: true,
    ocrReviewConfirmedAt: serverTimestamp,
    "ocrReview.status": "confirmed",
    "ocrReview.confirmedBy": uid,
    "ocrReview.confirmedAt": serverTimestamp,
    portalFinalSubmitApproved: true,
    updatedAt: serverTimestamp,
    "manualOverrides.updatedAt": serverTimestamp,
  };
}

function applyCorrectionPatch(patch, correction, serverTimestamp) {
  putStringPatch(patch, "rfcReceptor", correction.rfcReceptor, { uppercase: true });
  putStringPatch(patch, "manualOverrides.rfcReceptor", correction.rfcReceptor, { uppercase: true });
  putStringPatch(patch, "rfcEmisor", correction.rfcEmisor, { uppercase: true });
  putStringPatch(patch, "manualOverrides.rfcEmisor", correction.rfcEmisor, { uppercase: true });
  putStringPatch(patch, "folio", correction.folio);
  putStringPatch(patch, "manualOverrides.folio", correction.folio);
  putStringPatch(patch, "ocrCandidates.folioVenta", correction.folio);
  putStringPatch(patch, "manualOverrides.ocrCandidates.folioVenta", correction.folio);
  putStringPatch(patch, "ocrCandidates.ticketId", correction.ticketId, { uppercase: true });
  putStringPatch(patch, "manualOverrides.ocrCandidates.ticketId", correction.ticketId, { uppercase: true });
  putStringPatch(patch, "fecha", correction.fecha);
  putStringPatch(patch, "manualOverrides.fecha", correction.fecha);

  for (const field of ticketStringFields) {
    const value = correction[field];
    putStringPatch(patch, field, value);
    putStringPatch(patch, `manualOverrides.${field}`, value);
    putStringPatch(patch, `ocrCandidates.${field}`, value);
    putStringPatch(patch, `manualOverrides.ocrCandidates.${field}`, value);
  }

  if (correction.permisoCre) {
    patch.businessDomain = "fuel";
    patch["manualOverrides.businessDomain"] = "fuel";
    patch["ocrCandidates.businessDomain"] = "fuel";
    patch["manualOverrides.ocrCandidates.businessDomain"] = "fuel";
  }

  if (correction.monto !== null) {
    patch.monto = correction.monto;
    patch["manualOverrides.monto"] = correction.monto;
    patch["ocrCandidates.monto"] = correction.monto;
    patch["manualOverrides.ocrCandidates.monto"] = correction.monto;
  }

  patch["manualOverrides.updatedAt"] = serverTimestamp;
}

function sanitizeCorrection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const correction = {};
  for (const field of ["rfcReceptor", "rfcEmisor", "folio", "ticketId", "fecha", ...ticketStringFields]) {
    const normalized = normalizeTicketValue(value[field]);
    if (normalized) correction[field] = normalized;
  }

  const monto = parseAmount(value.monto);
  if (monto !== null) correction.monto = monto;

  return correction;
}

function parseAmount(value) {
  const normalized = clean(value).replaceAll(",", "");
  if (!normalized) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount >= 0 && amount <= 100_000_000
    ? amount
    : null;
}

function normalizeTicketValue(value) {
  return clean(value).slice(0, 512);
}

function putStringPatch(patch, key, value, { uppercase = false } = {}) {
  let normalized = normalizeTicketValue(value);
  if (!normalized) return;
  if (uppercase) normalized = normalized.toUpperCase();
  patch[key] = normalized;
}

function accept({ patch, event }) {
  return { ok: true, patch, event };
}

function reject(reason, message) {
  return { ok: false, reason, message };
}

function clean(value) {
  return String(value ?? "").trim();
}
