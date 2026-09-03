export const OCR_CHECKPOINT_VERSION = "ocr-checkpoint.v1";

const maxCheckpointBytes = 450_000;
const maxOcrTextLength = 120_000;

export function buildOcrCheckpoint({ job = {}, extracted = {} } = {}) {
  const extraction = cloneJsonValue({
    ...extracted,
    ocrText: truncate(extracted.ocrText, maxOcrTextLength),
  });
  const checkpoint = {
    version: OCR_CHECKPOINT_VERSION,
    ticketFileUrl: clean(job.ticketFileUrl),
    completedAt: new Date().toISOString(),
    extraction,
  };

  if (Buffer.byteLength(JSON.stringify(checkpoint), "utf8") <= maxCheckpointBytes) {
    return checkpoint;
  }

  // Full Vision text is useful for diagnostics but not required to resume the
  // portal stage. Drop it before risking Firestore's document size limit.
  checkpoint.extraction.ocrText = null;
  checkpoint.extraction.ocrTextPreview = truncate(
    checkpoint.extraction.ocrTextPreview,
    4_000,
  );
  return checkpoint;
}

export function readReusableOcrCheckpoint(job = {}) {
  if (!isOcrConfirmed(job) && !isAutonomousOcrResolved(job)) {
    return null;
  }

  const checkpoint = job.ocrCheckpoint;
  if (checkpoint) {
    if (
      checkpoint.version === OCR_CHECKPOINT_VERSION &&
      clean(checkpoint.ticketFileUrl) === clean(job.ticketFileUrl) &&
      checkpoint.extraction &&
      typeof checkpoint.extraction === "object"
    ) {
      return cloneJsonValue(checkpoint.extraction);
    }

    return null;
  }

  // Compatibility with jobs created before ocrCheckpoint.v1. The orchestrator
  // already persisted the relevant extraction fields at the document root.
  if (job.extractedData && typeof job.extractedData === "object") {
    return cloneJsonValue({
      ...job.extractedData,
      ocrText: job.ocrText ?? null,
      ocrTextPreview: job.ocrTextPreview ?? null,
      sourceType: job.sourceType ?? null,
      portalUrl: job.extractedData.portalUrl ?? job.portalCandidateUrl ?? null,
      portalDiscovery: job.extractedData.portalDiscovery ?? job.portalDiscovery ?? null,
      ticketEnrichment: job.extractedData.ticketEnrichment ?? job.ticketEnrichment ?? null,
      ocrCandidates: job.extractedData.ocrCandidates ?? job.ocrCandidates ?? {},
    });
  }

  return null;
}

export function isOcrConfirmed(job = {}) {
  return job.ocrReviewConfirmed === true || job.ocrReview?.status === "confirmed";
}

export function isAutonomousOcrResolved(job = {}) {
  if (job.processingMode !== "autonomous" && job.apiVersion !== "billing-http.v2") {
    return false;
  }

  return (
    job.ocrResolution?.status === "accepted" ||
    job.ocrCheckpoint?.extraction?.ocrResolution?.status === "accepted"
  );
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function truncate(value, maxLength) {
  if (value === null || value === undefined) return null;
  return String(value).slice(0, maxLength);
}

function clean(value) {
  return String(value ?? "").trim();
}
