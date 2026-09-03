import {
  getAutonomousOcrMaxCandidateSets,
  getAutonomousOcrMinimumConfidence,
} from "../config/env.mjs";
import { logger } from "../shared/logger.mjs";
import { extractTicketWithDocumentAiExpense } from "./document-ai-expense.service.mjs";
import { extractTicketWithGeminiVision } from "./gemini-ticket-extractor.mjs";
import { loadTrustedTicketImage } from "./ticket-image.service.mjs";

const sourceWeights = {
  qr_barcode: 0.99,
  document_ai_expense: 0.92,
  gemini_vision: 0.84,
  google_vision: 0.74,
};

const fieldNames = [
  "rfcEmisor",
  "fecha",
  "monto",
  "folio",
  "ticketId",
  "codigoFacturacion",
  "permisoCre",
  "sucursal",
  "serie",
  "token",
  "terminal",
  "webId",
];

const identifierFields = ["codigoFacturacion", "ticketId", "folio", "token", "webId"];

export function isAutonomousBillingJob(job = {}) {
  return job.processingMode === "autonomous" || job.apiVersion === "billing-http.v2";
}

export async function resolveAutonomousOcr({ job = {}, extracted = {}, providers = {} } = {}) {
  let image = null;
  const providerResults = [];

  try {
    image = await loadTrustedTicketImage(job.ticketFileUrl, { uid: job.uid });
    const runGemini = providers.gemini ?? extractTicketWithGeminiVision;
    const runDocumentAi = providers.documentAi ?? extractTicketWithDocumentAiExpense;
    const settled = await Promise.allSettled([
      runGemini({ image, receiverRfc: job.taxProfile?.rfc ?? job.rfcReceptor ?? null }),
      runDocumentAi({ image }),
    ]);

    for (const entry of settled) {
      providerResults.push(entry.status === "fulfilled"
        ? entry.value
        : {
            available: false,
            source: "unknown_provider",
            reason: "provider_error",
            error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
          });
    }
  } catch (error) {
    providerResults.push({
      available: false,
      source: "ticket_image",
      reason: "image_load_failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const resolution = fuseOcrCandidates({
    extracted,
    providerResults,
    receiverRfc: job.taxProfile?.rfc ?? job.rfcReceptor ?? null,
  });
  const next = applySelectedFields(extracted, resolution);

  logger.info("Autonomous OCR resolution completed.", {
    jobId: job.id ?? null,
    status: resolution.status,
    confidence: resolution.confidence,
    unresolvedFields: resolution.unresolvedFields,
    evidenceGate: {
      status: resolution.evidenceGate.status,
      reason: resolution.evidenceGate.reason,
      coreAgreementCount: resolution.evidenceGate.coreAgreementCount,
      textGroundedCount: resolution.evidenceGate.textGroundedCount,
    },
    providers: resolution.providers.map((provider) => ({
      source: provider.source,
      available: provider.available,
      reason: provider.reason ?? null,
    })),
  });

  return {
    extracted: next,
    resolution,
  };
}

export function fuseOcrCandidates({ extracted = {}, providerResults = [], receiverRfc = null } = {}) {
  const candidatesByField = new Map(fieldNames.map((field) => [field, []]));
  addVisionCandidates(candidatesByField, extracted);

  for (const provider of providerResults) {
    if (!provider?.available) continue;
    for (const field of fieldNames) {
      addCandidate(candidatesByField, field, provider.fields?.[field], {
        source: provider.source,
        confidence: provider.confidence,
      });
    }
    for (const alternative of provider.alternatives ?? []) {
      if (!fieldNames.includes(alternative.field)) continue;
      addCandidate(candidatesByField, alternative.field, alternative.value, {
        source: provider.source,
        confidence: alternative.confidence ?? provider.confidence,
        evidence: alternative.evidence ?? null,
      });
    }
  }

  const rankedFields = {};
  for (const field of fieldNames) {
    rankedFields[field] = rankFieldCandidates(field, candidatesByField.get(field), receiverRfc);
    if (field === "fecha") {
      rankedFields[field] = prioritizeDateCandidatesGroundedInText(
        rankedFields[field],
        extracted.ocrText ?? extracted.ocrTextPreview ?? "",
      );
    }
  }

  const selected = Object.fromEntries(
    fieldNames.map((field) => [field, rankedFields[field][0]?.value ?? null]),
  );
  if (sameText(selected.rfcEmisor, receiverRfc)) {
    selected.rfcEmisor = rankedFields.rfcEmisor.find((candidate) => !sameText(candidate.value, receiverRfc))?.value ?? null;
  }
  const selectedCandidates = Object.fromEntries(
    fieldNames.map((field) => [
      field,
      rankedFields[field].find((candidate) => sameText(candidate.value, selected[field])) ?? null,
    ]),
  );
  const candidateSets = buildCandidateSets(rankedFields, selected);
  const requiredFieldGaps = getUnresolvedFields(selected, extracted, receiverRfc);
  const identifierField = identifierFields.find((field) => selectedCandidates[field]);
  const selectedScores = ["rfcEmisor", "fecha", "monto", identifierField]
    .filter(Boolean)
    .map((field) => selectedCandidates[field]?.score)
    .filter(Number.isFinite);
  const confidence = selectedScores.length
    ? selectedScores.reduce((sum, score) => sum + score, 0) / selectedScores.length
    : 0;
  const evidenceGate = evaluateOcrEvidenceGate({
    extracted,
    selected,
    selectedCandidates,
    identifierField,
  });
  const unresolvedFields = [...requiredFieldGaps];
  if (requiredFieldGaps.length === 0 && !evidenceGate.accepted) {
    unresolvedFields.push("independentEvidence");
  }
  const accepted =
    unresolvedFields.length === 0 &&
    confidence >= getAutonomousOcrMinimumConfidence() &&
    evidenceGate.accepted;

  return {
    version: "autonomous-ocr.v2",
    mode: "autonomous",
    status: accepted ? "accepted" : "unresolved",
    confidence: round(confidence),
    selected,
    fields: Object.fromEntries(
      fieldNames.map((field) => [field, {
        value: selected[field],
        confidence: selectedCandidates[field]?.score ?? 0,
        sources: selectedCandidates[field]?.sources ?? [],
        candidates: rankedFields[field].slice(0, 6),
      }]),
    ),
    candidateSets,
    unresolvedFields,
    evidenceGate,
    providers: providerResults.map(summarizeProvider),
    resolvedAt: new Date().toISOString(),
  };
}

export function evaluateOcrEvidenceGate({
  extracted = {},
  selected = {},
  selectedCandidates = {},
  identifierField = null,
} = {}) {
  const rawText = String(extracted.ocrText ?? extracted.ocrTextPreview ?? "");
  const meaningfulText = hasMeaningfulOcrText(rawText);
  const coreFields = ["rfcEmisor", "fecha", "monto", identifierField]
    .filter((field, index, values) => field && values.indexOf(field) === index && selected[field] != null);
  const independentSources = new Set();
  const agreementFields = [];
  const textGroundedFields = [];

  for (const field of coreFields) {
    const sources = [...new Set(selectedCandidates[field]?.sources ?? [])];
    for (const source of sources) independentSources.add(source);
    if (sources.length >= 2) agreementFields.push(field);
    if (meaningfulText && valueAppearsInOcrText(field, selected[field], rawText)) {
      textGroundedFields.push(field);
    }
  }

  const qrValues = [
    ...toArray(extracted.qrValues),
    ...toArray(extracted.ocrCandidates?.qrValues),
    ...toArray(extracted.portalDiscovery?.qrValues),
  ].map((value) => String(value ?? "").trim()).filter(Boolean);
  const deterministicAnchor = qrValues.length > 0;
  const requiredStrongEvidence = Math.min(3, coreFields.length);
  const requiredMixedEvidence = Math.min(2, coreFields.length);
  const consensusPassed =
    requiredStrongEvidence > 0 && agreementFields.length >= requiredStrongEvidence;
  const textGroundingPassed =
    meaningfulText && requiredStrongEvidence > 0 && textGroundedFields.length >= requiredStrongEvidence;
  const mixedEvidencePassed =
    meaningfulText &&
    requiredMixedEvidence > 0 &&
    agreementFields.length >= requiredMixedEvidence &&
    textGroundedFields.length >= requiredMixedEvidence;
  const qrAnchoredPassed =
    deterministicAnchor &&
    meaningfulText &&
    requiredMixedEvidence > 0 &&
    textGroundedFields.length >= requiredMixedEvidence &&
    independentSources.size >= 2;
  const visibleDateCandidates = extractNormalizedDateTokens(rawText);
  const selectedDate = normalizeDate(selected.fecha);
  const dateConflict = Boolean(
    selectedDate &&
    visibleDateCandidates.length > 0 &&
    !visibleDateCandidates.includes(selectedDate),
  );
  const accepted =
    !dateConflict &&
    (consensusPassed || textGroundingPassed || mixedEvidencePassed || qrAnchoredPassed);

  let reason = "insufficient_independent_evidence";
  if (dateConflict) reason = "selected_date_conflicts_with_ocr_text";
  else if (consensusPassed) reason = "multi_source_consensus";
  else if (textGroundingPassed) reason = "ocr_text_grounded";
  else if (mixedEvidencePassed) reason = "mixed_consensus_and_text";
  else if (qrAnchoredPassed) reason = "qr_anchored_consensus";
  else if (!meaningfulText && independentSources.size <= 1) reason = "single_model_without_ocr_text";
  else if (!meaningfulText) reason = "insufficient_readable_ocr_text";
  else if (textGroundedFields.length < requiredMixedEvidence) reason = "selected_values_not_grounded";

  return {
    status: accepted ? "passed" : "failed",
    accepted,
    reason,
    meaningfulText,
    coreFieldCount: coreFields.length,
    coreAgreementCount: agreementFields.length,
    textGroundedCount: textGroundedFields.length,
    independentSourceCount: independentSources.size,
    deterministicAnchor,
    dateConflict,
    visibleDateCandidates,
    agreementFields,
    textGroundedFields,
    sources: [...independentSources],
  };
}

export function isAutonomousOcrAccepted(extracted = {}) {
  return extracted.ocrResolution?.status === "accepted";
}

function addVisionCandidates(target, extracted) {
  const confidence = extracted.ocrConfidence ?? {};
  const candidates = extracted.ocrCandidates ?? {};

  for (const field of fieldNames) {
    addCandidate(target, field, extracted[field] ?? candidates[field], {
      source: "google_vision",
      confidence: confidence[field] ?? 0.68,
    });
  }
  for (const rfc of toArray(candidates.rfc)) {
    addCandidate(target, "rfcEmisor", rfc, { source: "google_vision", confidence: 0.72 });
  }
  for (const value of toArray(candidates.folioVentaAlternates)) {
    addCandidate(target, "folio", value, { source: "google_vision", confidence: 0.56 });
  }
  for (const value of toArray(candidates.ticketIdAlternates)) {
    addCandidate(target, "ticketId", value, { source: "google_vision", confidence: 0.52 });
  }
  for (const value of toArray(candidates.montoAlternates)) {
    addCandidate(target, "monto", value, { source: "google_vision", confidence: 0.58 });
  }
}

function addCandidate(target, field, rawValue, metadata) {
  const value = normalizeFieldValue(field, rawValue);
  if (value === null) return;
  target.get(field).push({
    value,
    source: metadata.source,
    confidence: clamp(metadata.confidence, 0.65),
    evidence: metadata.evidence ?? null,
  });
}

function rankFieldCandidates(field, entries = [], receiverRfc = null) {
  const grouped = new Map();

  for (const entry of entries) {
    const key = candidateKey(field, entry.value);
    const group = grouped.get(key) ?? { value: entry.value, evidences: [] };
    group.evidences.push(entry);
    grouped.set(key, group);
  }

  return [...grouped.values()]
    .map((group) => {
      const uniqueSources = [...new Set(group.evidences.map((entry) => entry.source))];
      let missProbability = 1;
      for (const evidence of group.evidences) {
        const weight = sourceWeights[evidence.source] ?? 0.65;
        missProbability *= 1 - weight * evidence.confidence;
      }
      let score = 1 - missProbability + Math.max(0, uniqueSources.length - 1) * 0.06;
      if (field === "rfcEmisor" && sameText(group.value, receiverRfc)) score -= 0.35;
      return {
        value: group.value,
        score: round(Math.max(0, Math.min(1, score))),
        sources: uniqueSources,
        evidence: group.evidences.map((entry) => entry.evidence).filter(Boolean).slice(0, 3),
      };
    })
    .sort((a, b) => b.score - a.score);
}

function buildCandidateSets(rankedFields, selected) {
  const sets = [{
    rank: 1,
    score: scoreCandidateSet(selected, rankedFields),
    fields: { ...selected },
    reason: "highest_ranked_consensus",
  }];
  const ambiguous = fieldNames
    .map((field) => ({ field, candidate: rankedFields[field][1] }))
    .filter((entry) => entry.candidate)
    .sort((a, b) => b.candidate.score - a.candidate.score);

  for (const entry of ambiguous) {
    if (sets.length >= getAutonomousOcrMaxCandidateSets()) break;
    const fields = { ...selected, [entry.field]: entry.candidate.value };
    sets.push({
      rank: sets.length + 1,
      score: scoreCandidateSet(fields, rankedFields),
      fields,
      reason: `alternate_${entry.field}`,
    });
  }

  return sets;
}

function scoreCandidateSet(fields, rankedFields) {
  const scores = Object.entries(fields)
    .map(([field, value]) => rankedFields[field]?.find((candidate) => sameText(candidate.value, value))?.score)
    .filter(Number.isFinite);
  return round(scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0);
}

function getUnresolvedFields(selected, extracted, receiverRfc) {
  const unresolved = [];
  const hasPortal = Boolean(
    extracted.portalUrl || extracted.portalCandidateUrl || extracted.ocrCandidates?.portalUrls?.length,
  );
  if ((!selected.rfcEmisor || sameText(selected.rfcEmisor, receiverRfc)) && !hasPortal) {
    unresolved.push("rfcEmisor");
  }
  if (!selected.fecha) unresolved.push("fecha");
  if (!Number.isFinite(Number(selected.monto)) || Number(selected.monto) <= 0) unresolved.push("monto");
  if (!selected.folio && !selected.ticketId && !selected.codigoFacturacion && !selected.token && !selected.webId) {
    unresolved.push("ticketIdentifier");
  }
  const isFuel = extracted.businessDomain === "fuel" || extracted.ticketEnrichment?.fuel?.isFuel === true;
  if (isFuel && !selected.permisoCre) unresolved.push("permisoCre");
  return unresolved;
}

function hasMeaningfulOcrText(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const alphanumericCount = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
  const tokenCount = text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
  return alphanumericCount >= 24 && tokenCount >= 4;
}

function valueAppearsInOcrText(field, value, rawText) {
  if (value === null || value === undefined || value === "") return false;
  if (field === "monto") return amountAppearsInOcrText(value, rawText);

  const compactText = compactEvidenceText(rawText);
  if (!compactText) return false;
  if (field === "fecha") {
    const date = normalizeDate(value);
    if (!date) return false;
    return extractNormalizedDateTokens(rawText).includes(date);
  }

  const compactValue = compactEvidenceText(value);
  return compactValue.length >= 3 && compactText.includes(compactValue);
}

function amountAppearsInOcrText(value, rawText) {
  const expected = Number(value);
  if (!Number.isFinite(expected)) return false;
  const normalized = String(rawText ?? "").replace(/\u00a0/g, " ");
  const numericTokens = normalized.match(/-?\$?\s*\d{1,9}(?:[.,]\d{1,2})?/g) ?? [];
  return numericTokens.some((token) => {
    const parsed = parseLocalizedNumber(token.replace(/[$\s]/g, ""));
    return Number.isFinite(parsed) && Math.abs(parsed - expected) < 0.005;
  });
}

function compactEvidenceText(value) {
  return String(value ?? "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^A-Z0-9&Ñ]/g, "");
}

function applySelectedFields(extracted, resolution) {
  const selected = resolution.selected;
  const next = {
    ...extracted,
    ocrResolution: resolution,
    ocrCandidates: {
      ...(extracted.ocrCandidates ?? {}),
      autonomousCandidateSets: resolution.candidateSets,
    },
    ocrConfidence: {
      ...(extracted.ocrConfidence ?? {}),
    },
  };

  for (const field of fieldNames) {
    if (selected[field] !== null && selected[field] !== undefined && selected[field] !== "") {
      next[field] = selected[field];
      next.ocrConfidence[field] = resolution.fields[field]?.confidence ?? next.ocrConfidence[field] ?? 0;
      if (!["rfcEmisor", "fecha", "monto", "folio"].includes(field)) {
        next.ocrCandidates[field] = selected[field];
      }
    }
  }
  if (selected.folio) next.ocrCandidates.folioVenta = selected.folio;
  if (selected.monto) next.ocrCandidates.monto = selected.monto;
  if (selected.fecha) next.ocrCandidates.fecha = selected.fecha;
  return next;
}

function normalizeFieldValue(field, value) {
  if (value === null || value === undefined || value === "") return null;
  if (field === "monto") {
    const text = String(value).toUpperCase().replace(/MXN|M\.N\./g, "").replace(/[$\s]/g, "");
    const parsed = parseLocalizedNumber(text);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  if (field === "rfcEmisor") {
    const normalized = String(value).toUpperCase().replace(/[^A-Z0-9&Ñ]/g, "");
    return /^[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}$/.test(normalized) ? normalized : null;
  }
  if (field === "fecha") return normalizeDate(value);
  const text = String(value).trim();
  return text || null;
}

function parseLocalizedNumber(value) {
  const text = String(value ?? "").trim();
  if (/^-?\d{1,9},\d{2}$/.test(text) && !text.includes(".")) {
    return Number(text.replace(",", "."));
  }
  return Number(text.replace(/,/g, ""));
}

function normalizeDate(value) {
  const text = String(value ?? "").trim();
  let match = /^(20\d{2})[./-]([01]?\d)[./-]([0-3]?\d)$/.exec(text);
  if (match) return validIsoDate(match[1], match[2], match[3]);
  match = /^([0-3]?\d)[./-]([01]?\d)[./-](\d{2,4})$/.exec(text);
  if (!match) return null;
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return validIsoDate(year, match[2], match[1]);
}

function prioritizeDateCandidatesGroundedInText(candidates, rawText) {
  const visibleDates = new Set(extractNormalizedDateTokens(rawText));
  if (!visibleDates.size) return candidates;

  return candidates
    .map((candidate, index) => ({
      ...candidate,
      textGrounded: visibleDates.has(normalizeDate(candidate.value)),
      originalIndex: index,
    }))
    .sort((left, right) => {
      if (left.textGrounded !== right.textGrounded) return left.textGrounded ? -1 : 1;
      if (right.score !== left.score) return right.score - left.score;
      return left.originalIndex - right.originalIndex;
    })
    .map(({ originalIndex, ...candidate }) => candidate);
}

function extractNormalizedDateTokens(rawText) {
  const text = String(rawText ?? "");
  const tokens = [];
  const pattern = /(?<!\d)(\d{1,4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,4})(?!\d)/g;

  for (const match of text.matchAll(pattern)) {
    let normalized = null;
    if (/^20\d{2}$/.test(match[1])) {
      normalized = validIsoDate(match[1], match[2], match[3]);
    } else if (match[1].length <= 2 && match[3].length >= 2) {
      const first = Number(match[1]);
      const second = Number(match[2]);
      const monthFirst = first <= 12 && second > 12;
      const year = match[3].length === 2 ? `20${match[3]}` : match[3];
      normalized = validIsoDate(year, monthFirst ? first : second, monthFirst ? second : first);
    }
    if (normalized && !tokens.includes(normalized)) tokens.push(normalized);
  }

  return tokens;
}

function validIsoDate(year, month, day) {
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso ? null : iso;
}

function candidateKey(field, value) {
  return field === "monto" ? Number(value).toFixed(2) : String(value).trim().toUpperCase();
}

function summarizeProvider(provider = {}) {
  return {
    source: provider.source ?? "unknown",
    available: provider.available === true,
    model: provider.model ?? null,
    reason: provider.reason ?? null,
    retryable: provider.retryable === true,
    document: provider.document
      ? {
          isTicket: provider.document.isTicket === true,
          hasReadableText: provider.document.hasReadableText === true,
        }
      : null,
  };
}

function sameText(left, right) {
  return String(left ?? "").trim().toUpperCase() === String(right ?? "").trim().toUpperCase();
}

function toArray(value) {
  return Array.isArray(value) ? value : value === null || value === undefined || value === "" ? [] : [value];
}

function clamp(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
}

function round(value) {
  return Math.round(Number(value) * 1000) / 1000;
}
