import assert from "node:assert/strict";
import {
  fuseOcrCandidates,
  isAutonomousOcrAccepted,
} from "../ocr/autonomous-ocr.service.mjs";
import { extractFields } from "../ocr/google-vision-ocr.service.mjs";
import {
  buildMandatoryOcrConfirmation,
  buildPortalAttemptContexts,
} from "../orchestrator/autopilot-policy.mjs";
import { buildOcrCheckpoint, readReusableOcrCheckpoint } from "../orchestrator/ocr-checkpoint.mjs";
import { deriveWorkflowStageAfterResult } from "../jobs/job-workflow.mjs";
import { buildReleasedJobDispatch } from "../queue/billing-queue-runtime.mjs";

const resolution = fuseOcrCandidates({
  receiverRfc: "XAXX010101000",
  extracted: {
    rfcEmisor: "XAXX010101000",
    fecha: "2026-05-17",
    monto: 10,
    folio: "20242",
    ocrConfidence: { rfcEmisor: 0.62, fecha: 0.7, monto: 0.58, folio: 0.66 },
    ocrCandidates: {
      rfc: ["XAXX010101000", "OCS120223SN2"],
      montoAlternates: [10, 100],
      folioVenta: "20242",
    },
  },
  providerResults: [
    {
      available: true,
      source: "gemini_vision",
      confidence: 0.9,
      fields: {
        rfcEmisor: "OCS120223SN2",
        fecha: "2026-05-17",
        monto: 100,
        folio: "20242",
      },
      alternatives: [],
    },
    {
      available: true,
      source: "document_ai_expense",
      confidence: 0.92,
      fields: { fecha: "2026-05-17", monto: 100 },
      alternatives: [],
    },
  ],
});

assert.equal(resolution.status, "accepted");
assert.equal(resolution.selected.rfcEmisor, "OCS120223SN2");
assert.equal(resolution.fields.rfcEmisor.value, "OCS120223SN2");
assert.ok(resolution.fields.rfcEmisor.sources.includes("gemini_vision"));
assert.equal(resolution.selected.monto, 100);
assert.equal(resolution.unresolvedFields.length, 0);
assert.equal(resolution.evidenceGate.status, "passed");
assert.equal(resolution.evidenceGate.reason, "multi_source_consensus");
assert.ok(resolution.candidateSets.length >= 2);
assert.ok(resolution.candidateSets.length <= 4);

const extracted = {
  ...resolution.selected,
  ocrResolution: resolution,
  ocrCandidates: { autonomousCandidateSets: resolution.candidateSets },
};
assert.equal(isAutonomousOcrAccepted(extracted), true);

const review = buildMandatoryOcrConfirmation({
  job: { processingMode: "autonomous" },
  extracted,
});
assert.equal(review.requiresUserAction, false);
assert.equal(review.reviewMode, "autonomous_candidate_resolution");

const attempts = buildPortalAttemptContexts({
  baseContext: extracted,
  extracted,
});
assert.ok(attempts.length >= 2);
assert.equal(attempts[0].context.monto, 100);
assert.ok(attempts.every((attempt) => attempt.context.rfcEmisor === "OCS120223SN2"));

const checkpoint = buildOcrCheckpoint({
  job: { ticketFileUrl: "mock://ticket" },
  extracted,
});
const reused = readReusableOcrCheckpoint({
  processingMode: "autonomous",
  ticketFileUrl: "mock://ticket",
  ocrResolution: resolution,
  ocrCheckpoint: checkpoint,
});
assert.equal(reused.monto, 100);
assert.equal(deriveWorkflowStageAfterResult(
  { workflowStage: "ocr", status: "ocr_processing" },
  { status: "pending", workflowStage: "portal" },
), "portal");
assert.deepEqual(buildReleasedJobDispatch({
  job: { id: "job_auto", uid: "user_1", attemptCount: 1 },
  result: { status: "pending", workflowStage: "portal" },
  workerLane: "ocr",
}), {
  uid: "user_1",
  jobId: "job_auto",
  lane: "portal",
  generation: "stage-portal-1",
  reason: "workflow_stage_advanced",
});

const unresolved = fuseOcrCandidates({
  extracted: { monto: 100 },
  providerResults: [],
});
assert.equal(unresolved.status, "unresolved");
assert.ok(unresolved.unresolvedFields.includes("fecha"));
assert.ok(unresolved.unresolvedFields.includes("ticketIdentifier"));

const geminiOnlyHallucination = fuseOcrCandidates({
  receiverRfc: "XAXX010101000",
  extracted: {
    ocrText: "",
    ocrCandidates: {},
  },
  providerResults: [{
    available: true,
    source: "gemini_vision",
    confidence: 0.99,
    fields: {
      rfcEmisor: "GME0505106U5",
      fecha: "2026-05-17",
      monto: 100,
      folio: "FAKE123456",
    },
  }],
});
assert.equal(geminiOnlyHallucination.status, "unresolved");
assert.ok(geminiOnlyHallucination.unresolvedFields.includes("independentEvidence"));
assert.equal(geminiOnlyHallucination.evidenceGate.reason, "single_model_without_ocr_text");

const groundedGoogleVision = fuseOcrCandidates({
  receiverRfc: "XAXX010101000",
  extracted: {
    rfcEmisor: "OCS120223SN2",
    fecha: "2026-05-17",
    monto: 100,
    folio: "20242",
    ocrText: [
      "TIERRA GARAT SUCURSAL ZONA AZUL",
      "Fecha 17/05/2026",
      "Total 100.00",
      "Ticket #20242",
      "RFC OCS120223SN2",
    ].join("\n"),
    ocrConfidence: { rfcEmisor: 0.86, fecha: 0.84, monto: 0.82, folio: 0.8 },
  },
  providerResults: [],
});
assert.equal(groundedGoogleVision.status, "accepted");
assert.equal(groundedGoogleVision.evidenceGate.reason, "ocr_text_grounded");
assert.equal(groundedGoogleVision.evidenceGate.textGroundedCount, 4);

const ungroundedGeminiWithUnrelatedText = fuseOcrCandidates({
  extracted: {
    ocrText: "ESTE DOCUMENTO CONTIENE TEXTO LEGIBLE PERO NO CONTIENE DATOS DE COMPRA",
  },
  providerResults: [{
    available: true,
    source: "gemini_vision",
    confidence: 0.99,
    fields: {
      rfcEmisor: "GME0505106U5",
      fecha: "2026-05-17",
      monto: 100,
      folio: "FAKE123456",
    },
  }],
});
assert.equal(ungroundedGeminiWithUnrelatedText.status, "unresolved");
assert.equal(ungroundedGeminiWithUnrelatedText.evidenceGate.reason, "selected_values_not_grounded");

const sanPabloOcrText = [
  "FARMACIA SAN PABLO RFC PPL961114GZ1",
  "Fecha Hora Tienda TPV Empl Transac",
  "13.06.26 15:24 116 4 IPSM 102190",
  "Total 68.00",
  "Folio Facturacion: 011604202606130102190",
].join("\n");
const sanPabloDeterministic = extractFields(sanPabloOcrText);
assert.equal(sanPabloDeterministic.fecha, "2026-06-13");

const sanPabloResolution = fuseOcrCandidates({
  receiverRfc: "XAXX010101000",
  extracted: {
    ...sanPabloDeterministic,
    ocrText: sanPabloOcrText,
    folio: "011604202606130102190",
    ocrCandidates: {
      ...(sanPabloDeterministic.ocrCandidates ?? {}),
      folioVenta: "011604202606130102190",
    },
  },
  providerResults: [{
    available: true,
    source: "gemini_vision",
    confidence: 0.94,
    fields: {
      rfcEmisor: "PPL961114GZ1",
      fecha: "2013-06-26",
      monto: 68,
      folio: "011604202606130102190",
    },
  }],
});
assert.equal(sanPabloResolution.selected.fecha, "2026-06-13");
assert.equal(sanPabloResolution.fields.fecha.candidates[0].textGrounded, true);
assert.equal(sanPabloResolution.evidenceGate.dateConflict, false);
assert.deepEqual(sanPabloResolution.evidenceGate.visibleDateCandidates, ["2026-06-13"]);

const conflictingDateResolution = fuseOcrCandidates({
  extracted: {
    ocrText: sanPabloOcrText,
    rfcEmisor: "PPL961114GZ1",
    monto: 68,
    folio: "011604202606130102190",
  },
  providerResults: [{
    available: true,
    source: "gemini_vision",
    confidence: 0.99,
    fields: {
      rfcEmisor: "PPL961114GZ1",
      fecha: "2013-06-26",
      monto: 68,
      folio: "011604202606130102190",
    },
  }],
});
assert.equal(conflictingDateResolution.status, "unresolved");
assert.equal(conflictingDateResolution.evidenceGate.reason, "selected_date_conflicts_with_ocr_text");

console.log("Autonomous OCR validation passed.");
