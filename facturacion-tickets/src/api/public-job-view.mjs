const terminalStatuses = new Set(["completed", "resolved", "failed", "cancelled", "expired"]);
const waitingForUserStatuses = new Set(["ocr_review_required", "needs_user_action"]);

export function projectPublicBillingJob(job = {}) {
  const normalized = normalizeFirestoreValue(job);
  const status = clean(normalized.status) || "unknown";

  return {
    id: clean(normalized.id),
    status,
    processingMode: clean(normalized.processingMode) || "interactive",
    workflowStage: clean(normalized.workflowStage) || null,
    statusMessage: clean(normalized.statusMessage) || null,
    attemptCount: Number(normalized.attemptCount ?? 0),
    createdAt: normalized.createdAt ?? null,
    updatedAt: normalized.updatedAt ?? null,
    retryAt: normalized.retryAt ?? null,
    ticket: {
      rfcEmisor: clean(normalized.rfcEmisor) || null,
      rfcReceptor: clean(normalized.rfcReceptor) || null,
      folio: clean(normalized.folio) || null,
      ticketId: clean(normalized.ticketId ?? normalized.ocrCandidates?.ticketId) || null,
      codigoFacturacion:
        clean(normalized.codigoFacturacion ?? normalized.ocrCandidates?.codigoFacturacion) || null,
      fecha: clean(normalized.fecha) || null,
      monto: finiteNumber(normalized.monto),
      permisoCre: clean(normalized.permisoCre ?? normalized.ocrCandidates?.permisoCre) || null,
      sucursal: clean(normalized.sucursal ?? normalized.ocrCandidates?.sucursal) || null,
    },
    ocrReview: normalized.ocrReview ?? null,
    ocrResolution: normalizeOcrResolution(normalized.ocrResolution),
    userAction: normalized.userAction ?? null,
    result: {
      xmlUrl: clean(normalized.resultXmlUrl) || null,
      pdfUrl: clean(normalized.resultPdfUrl) || null,
      xmlStoragePath: clean(normalized.resultXmlStoragePath) || null,
      pdfStoragePath: clean(normalized.resultPdfStoragePath) || null,
      validation: normalized.cfdiValidationResult ?? null,
      warning: clean(normalized.completionWarning) || null,
    },
    error: normalizeError(normalized.error ?? normalized.lastError),
    isTerminal: terminalStatuses.has(status),
    needsUserAction: waitingForUserStatuses.has(status),
    pollAfterMs: getPollAfterMs(status),
  };
}

function normalizeOcrResolution(value) {
  if (!value) return null;
  return {
    status: clean(value.status) || null,
    confidence: finiteNumber(value.confidence),
    unresolvedFields: Array.isArray(value.unresolvedFields) ? value.unresolvedFields : [],
    candidateSetCount: Array.isArray(value.candidateSets) ? value.candidateSets.length : 0,
    evidenceGate: value.evidenceGate ?? null,
    providers: Array.isArray(value.providers) ? value.providers : [],
  };
}

export function projectPublicBillingEvent(event = {}) {
  const normalized = normalizeFirestoreValue(event);
  return {
    id: clean(normalized.id) || null,
    type: clean(normalized.type) || "event",
    status: clean(normalized.status) || null,
    message: clean(normalized.message) || null,
    actor: clean(normalized.actor) || null,
    createdAt: normalized.createdAt ?? null,
  };
}

export function normalizeFirestoreValue(value) {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value?.toDate === "function") return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(normalizeFirestoreValue);

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !key.startsWith("_"))
        .map(([key, entry]) => [key, normalizeFirestoreValue(entry)]),
    );
  }

  return value;
}

function getPollAfterMs(status) {
  if (terminalStatuses.has(status) || waitingForUserStatuses.has(status)) return 0;
  if (status === "retry_scheduled") return 10_000;
  if (status.endsWith("_processing")) return 3_000;
  return 5_000;
}

function normalizeError(value) {
  if (!value) return null;
  if (typeof value === "string") return { message: value };

  return {
    code: clean(value.code ?? value.reason) || null,
    message: clean(value.message ?? value.error) || "Error de procesamiento",
    retryable: value.retryable === true,
  };
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clean(value) {
  return String(value ?? "").trim();
}
