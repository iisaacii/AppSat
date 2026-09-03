import { validateTaxProfile } from "../contracts/factura-job-contract.mjs";
import {
  getBillingPortalVariantMaxAttempts,
  isBillingAutopilotEnabled,
  isBillingAutopilotFinalSubmitEnabled,
} from "../config/env.mjs";
import {
  isAutonomousBillingJob,
  isAutonomousOcrAccepted,
} from "../ocr/autonomous-ocr.service.mjs";

const confidenceThresholds = {
  rfcEmisor: 0.65,
  folio: 0.45,
  fecha: 0.55,
  monto: 0.55,
  permisoCre: 0.75,
};

const ticketFieldSources = new Set(["rfcEmisor", "folio", "fecha", "monto", "permisoCre"]);

export function buildMandatoryOcrConfirmation({ job, extracted, fieldResolution = null, template = null } = {}) {
  const hasPortal = hasPortalCandidate(job) || hasPortalCandidate(extracted) || Boolean(template);
  const requireEmitterRfc = !hasPortal;
  const fieldReview = buildOcrFieldReview({ extracted, fieldResolution, template, requireEmitterRfc });
  const confirmed = isOcrReviewConfirmed(job);

  if (isAutonomousBillingJob(job) && isAutonomousOcrAccepted(extracted)) {
    return {
      ...fieldReview,
      ready: true,
      requiresUserAction: false,
      reason: "ocr_autonomous_resolved",
      statusMessage: "OCR resuelto automaticamente con candidatos validados",
      reviewMode: "autonomous_candidate_resolution",
      userConfirmed: false,
      editableFields: [],
    };
  }

  if (confirmed) {
    const unresolvedIssues = fieldReview.missingTicketFields.filter((issue) =>
      isConfirmedIssueStillUnresolved(issue, extracted),
    );

    return {
      ...fieldReview,
      ready: unresolvedIssues.length === 0,
      requiresUserAction: unresolvedIssues.length > 0,
      reviewMode: "validated_after_user_confirmation",
      userConfirmed: true,
      missingTicketFields: unresolvedIssues,
      editableFields: unresolvedIssues,
      statusMessage: unresolvedIssues.length
        ? "No se pudieron extraer todos los datos del ticket; revisa y corrige los campos detectados"
        : "OCR confirmado por el usuario",
    };
  }

  const editableFields = buildOcrConfirmationEditableFields({
    extracted,
    issues: fieldReview.missingTicketFields,
    requireEmitterRfc,
  });

  return {
    ...fieldReview,
    ready: false,
    requiresUserAction: true,
    reason: "ocr_user_confirmation_required",
    statusMessage: "Revisa y confirma los datos detectados del ticket antes de facturar.",
    reviewMode: "mandatory_user_confirmation",
    userConfirmed: false,
    editableFields,
  };
}

export function buildOcrFieldReview({ extracted, fieldResolution = null, template = null, requireEmitterRfc = null } = {}) {
  const missingTicketFields = getMissingTicketFields(fieldResolution);
  const generalIssues = [];

  if (!fieldResolution) {
    const shouldRequire = requireEmitterRfc ?? !template;
    generalIssues.push(...getMissingGeneralTicketFields(extracted, { requireEmitterRfc: shouldRequire }));
  }

  const domainIssues = getDomainCriticalTicketIssues(extracted);
  const issues = [...generalIssues, ...domainIssues, ...missingTicketFields];
  const lowConfidence = getLowConfidenceWarnings(extracted);

  return {
    ready: issues.length === 0,
    requiresUserAction: issues.length > 0,
    reason: issues.length ? "ocr_ticket_fields_required" : "ocr_ready",
    statusMessage: issues.length
      ? "No se pudieron extraer todos los datos del ticket; revisa y corrige los campos detectados"
      : "OCR listo para intentar facturacion automatica",
    missingTicketFields: issues,
    lowConfidence,
  };
}

function isOcrReviewConfirmed(job = {}) {
  return (
    job?.ocrReviewConfirmed === true ||
    job?.ocrReview?.status === "confirmed" ||
    job?.ocrReview?.confirmed === true
  );
}

function isConfirmedIssueStillUnresolved(issue = {}, extracted = {}) {
  const field = issue.field ?? issue.name ?? issue.key;

  if (!field) {
    return true;
  }

  const hardFieldsAfterConfirmation = new Set(["rfcEmisor", "fecha", "monto"]);

  if (!hardFieldsAfterConfirmation.has(field)) {
    return false;
  }

  const value = extracted?.[field] ?? extracted?.ocrCandidates?.[field];

  if (isMissing(value)) {
    return true;
  }

  return !String(issue.reason ?? "").startsWith("low_confidence");
}

function buildOcrConfirmationEditableFields({ extracted = {}, issues = [], requireEmitterRfc = true } = {}) {
  const candidates = extracted.ocrCandidates ?? {};
  const baseFields = [
    confirmationField("rfcEmisor", extracted.rfcEmisor ?? firstArrayValue(candidates.rfc), "RFC emisor", null, requireEmitterRfc),
    confirmationField("folio", extracted.folio ?? candidates.folioVenta ?? candidates.ticketId, "Folio/ticket"),
    confirmationField("codigoFacturacion", extracted.codigoFacturacion ?? candidates.codigoFacturacion, "Codigo de facturacion"),
    confirmationField("ticketId", extracted.ticketId ?? candidates.ticketId, "ID de ticket"),
    confirmationField("fecha", extracted.fecha ?? candidates.fecha, "Fecha"),
    confirmationField("monto", extracted.monto ?? candidates.monto, "Monto"),
  ];
  const optionalFields = [
    confirmationField("permisoCre", extracted.permisoCre ?? candidates.permisoCre, "Permiso CRE"),
    confirmationField("estacionCodigo", extracted.estacionCodigo ?? candidates.estacionCodigo, "Codigo de estacion"),
    confirmationField("estacionNombre", extracted.estacionNombre ?? candidates.estacionNombre, "Nombre de estacion"),
    confirmationField("sucursal", extracted.sucursal ?? candidates.sucursal, "Sucursal"),
    confirmationField("serie", extracted.serie ?? candidates.serie, "Serie"),
    confirmationField("token", extracted.token ?? candidates.token, "Token"),
    confirmationField("terminal", extracted.terminal ?? candidates.terminal, "Terminal"),
    confirmationField("webId", extracted.webId ?? candidates.webId, "Web ID"),
  ].filter((field) => !isMissing(field.value));
  const byKey = new Map([...baseFields, ...optionalFields].map((field) => [field.key, field]));

  for (const issue of issues) {
    const key = issue.field ?? issue.name ?? null;

    if (!key || byKey.has(key)) {
      continue;
    }

    byKey.set(key, confirmationField(key, extracted[key] ?? candidates[key] ?? null, issue.label ?? key, issue));
  }

  return [...byKey.values()];
}

function confirmationField(key, value, label, issue = null, forceRequired = null) {
  const isHardcodedRequired = ["folio", "fecha", "monto"].includes(key) || (key === "rfcEmisor" && (forceRequired ?? true));
  return {
    key,
    label,
    value: value ?? null,
    expectedValue: issue?.expectedValue ?? null,
    confidence: issue?.confidence ?? null,
    reason: issue?.reason ?? null,
    required: isHardcodedRequired || Boolean(issue),
  };
}

function getMissingGeneralTicketFields(extracted, { requireEmitterRfc }) {
  const issues = [];

  if (requireEmitterRfc && isMissing(extracted?.rfcEmisor)) {
    issues.push({
      field: "rfcEmisor",
      label: "RFC emisor",
      reason: "missing_emitter_rfc",
    });
  }

  if (isMissing(extracted?.fecha)) {
    issues.push({
      field: "fecha",
      label: "Fecha del ticket",
      reason: "missing_ticket_field",
    });
  }

  if (isMissing(extracted?.monto)) {
    issues.push({
      field: "monto",
      label: "Monto total",
      reason: "missing_ticket_field",
    });
  }

  if (
    isMissing(extracted?.folio) &&
    isMissing(extracted?.ocrCandidates?.folioVenta) &&
    isMissing(extracted?.ocrCandidates?.ticketId)
  ) {
    issues.push({
      field: "folio",
      label: "Folio o ID del ticket",
      reason: "missing_ticket_identifier",
    });
  }

  return issues;
}

function getDomainCriticalTicketIssues(extracted) {
  const issues = [];
  const isFuelTicket = extracted?.businessDomain === "fuel" || extracted?.ticketEnrichment?.fuel?.isFuel === true;

  if (!isFuelTicket) {
    return issues;
  }

  const permisoCreReview = extracted?.ticketEnrichment?.permisoCre;
  const permisoCre = extracted?.permisoCre ?? extracted?.ocrCandidates?.permisoCre;

  if (isMissing(permisoCre)) {
    issues.push({
      field: "permisoCre",
      label: "Permiso CRE",
      reason: "missing_fuel_permit_cre",
      source: "ticketEnrichment.permisoCre",
    });
  } else if (permisoCreReview?.needsReview && extracted?.manualOverridesApplied !== true) {
    issues.push({
      field: "permisoCre",
      label: "Permiso CRE",
      reason: "low_confidence_fuel_permit_cre",
      source: "ticketEnrichment.permisoCre",
      confidence: permisoCreReview.confidence ?? extracted?.ocrConfidence?.permisoCre ?? null,
      candidates: permisoCreReview.candidates ?? [],
    });
  }

  return issues;
}

export function buildAutopilotDecision({ job, extracted, template = null, fieldResolution = null, preflightResult = null } = {}) {
  const profileErrors = validateTaxProfile(job?.taxProfile ?? {});
  const hasPortal = hasPortalCandidate(job) || hasPortalCandidate(extracted) || Boolean(template);
  const ocrReview = isAutonomousBillingJob(job) && isAutonomousOcrAccepted(extracted)
    ? {
        ...buildOcrFieldReview({
          extracted,
          template,
          fieldResolution,
          requireEmitterRfc: !hasPortal,
        }),
        ready: true,
        requiresUserAction: false,
        reason: "ocr_autonomous_resolved",
      }
    : buildOcrFieldReview({
        extracted,
        template,
        fieldResolution,
        requireEmitterRfc: !hasPortal,
      });
  const checks = {
    autopilotEnabled: isBillingAutopilotEnabled(),
    autopilotFinalSubmitEnabled: isBillingAutopilotFinalSubmitEnabled(),
    jobApprovedFinalSubmit: job?.portalFinalSubmitApproved === true,
    taxProfileComplete: profileErrors.length === 0,
    ocrReady: !ocrReview.requiresUserAction,
    preflightAllowed: preflightResult?.blocked !== true,
  };
  const blockedBy = [];

  if (!checks.autopilotEnabled) blockedBy.push("autopilot_disabled");
  if (!checks.autopilotFinalSubmitEnabled) blockedBy.push("autopilot_final_submit_disabled");
  if (!checks.taxProfileComplete) blockedBy.push("tax_profile_incomplete");
  if (!checks.ocrReady) blockedBy.push("ocr_review_required");
  if (!checks.preflightAllowed) blockedBy.push("portal_preflight_blocked");

  const approveFinalSubmit = checks.jobApprovedFinalSubmit || blockedBy.length === 0;

  return {
    mode: checks.autopilotEnabled ? "safe" : "disabled",
    approveFinalSubmit,
    approvalSource: checks.jobApprovedFinalSubmit ? "job" : approveFinalSubmit ? "autopilot" : null,
    blockedBy: checks.jobApprovedFinalSubmit ? [] : blockedBy,
    checks,
    taxProfileErrors: profileErrors,
    ocrReview,
  };
}

export function applyAutopilotApprovalToJob(job, autopilotDecision) {
  if (!autopilotDecision?.approveFinalSubmit) {
    return job;
  }

  return {
    ...job,
    portalFinalSubmitApproved: true,
    autopilotDecision,
  };
}

export function applyAutopilotApprovalToContext(context, autopilotDecision) {
  if (!autopilotDecision?.approveFinalSubmit) {
    return {
      ...context,
      autopilotDecision,
    };
  }

  return {
    ...context,
    portalFinalSubmitApproved: true,
    autopilotDecision,
  };
}

export function buildPortalAttemptContexts({ baseContext, extracted } = {}) {
  const maxAttempts = Math.max(1, getBillingPortalVariantMaxAttempts());
  const attempts = [];
  const seen = new Set();

  const addAttempt = (context, variant) => {
    if (attempts.length >= maxAttempts) {
      return;
    }

    const signature = buildAttemptSignature(context);
    if (seen.has(signature)) {
      return;
    }

    seen.add(signature);
    attempts.push({
      index: attempts.length + 1,
      context,
      variant,
    });
  };

  addAttempt(baseContext, {
    type: "original",
    fields: {},
  });

  for (const candidateSet of toArray(extracted?.ocrResolution?.candidateSets)) {
    const portalFields = pickPortalCandidateFields(candidateSet?.fields);
    const candidateContext = {
      ...baseContext,
      ...portalFields,
    };
    addAttempt(candidateContext, {
      type: "autonomous_ocr_candidate_set",
      candidateRank: candidateSet?.rank ?? null,
      candidateScore: candidateSet?.score ?? null,
      reason: candidateSet?.reason ?? null,
      fields: buildVariantFields(baseContext, candidateContext, portalFields),
    });
  }

  const ticketIds = normalizeCandidateList(extracted?.ocrCandidates?.ticketIdAlternates, baseContext?.ticketId);
  const folios = normalizeCandidateList(
    [
      ...(toArray(extracted?.ocrCandidates?.folioVentaAlternates)),
      ...(toArray(extracted?.ocrCandidates?.folioAlternates)),
    ],
    baseContext?.folio,
  );

  for (const ticketId of ticketIds) {
    addAttempt(
      {
        ...baseContext,
        ticketId,
      },
      {
        type: "ocr_variant",
        fields: {
          ticketId: {
            original: baseContext?.ticketId ?? null,
            value: ticketId,
            source: "ocrCandidates.ticketIdAlternates",
          },
        },
      },
    );
  }

  for (const folio of folios) {
    addAttempt(
      {
        ...baseContext,
        folio,
      },
      {
        type: "ocr_variant",
        fields: {
          folio: {
            original: baseContext?.folio ?? null,
            value: folio,
            source: "ocrCandidates.folioAlternates",
          },
        },
      },
    );
  }

  for (const ticketId of ticketIds.slice(0, 4)) {
    for (const folio of folios.slice(0, 4)) {
      addAttempt(
        {
          ...baseContext,
          ticketId,
          folio,
        },
        {
          type: "ocr_variant",
          fields: {
            ticketId: {
              original: baseContext?.ticketId ?? null,
              value: ticketId,
              source: "ocrCandidates.ticketIdAlternates",
            },
            folio: {
              original: baseContext?.folio ?? null,
              value: folio,
              source: "ocrCandidates.folioAlternates",
            },
          },
        },
      );
    }
  }

  return attempts;
}

export function shouldRetryPortalAttempt(result) {
  return result?.safeStop === true && result.reason === "ticket_validation_rejected";
}

export function applySelectedVariantToExtractionPatch(extractionPatch, variant) {
  if (!variant?.fields || Object.keys(variant.fields).length === 0) {
    return extractionPatch;
  }

  const nextCandidates = {
    ...(extractionPatch.ocrCandidates ?? {}),
    ...(extractionPatch.extractedData?.ocrCandidates ?? {}),
  };
  const nextExtractedData = {
    ...(extractionPatch.extractedData ?? {}),
    ocrCandidates: nextCandidates,
  };
  const patch = {
    ...extractionPatch,
    extractedData: nextExtractedData,
    portalSelectedFieldVariant: variant,
  };

  for (const [field, selection] of Object.entries(variant.fields)) {
    if (!selection || isMissing(selection.value)) continue;
    patch[field] = selection.value;
    nextExtractedData[field] = selection.value;

    if (field === "folio") {
      nextCandidates.folioVenta = selection.value;
    } else if (!new Set(["rfcEmisor", "fecha", "monto"]).has(field)) {
      nextCandidates[field] = selection.value;
    }
  }

  patch.ocrCandidates = nextCandidates;
  return patch;
}

function getMissingTicketFields(fieldResolution) {
  return (fieldResolution?.missingFields ?? [])
    .filter((field) => isTicketFieldSource(field.source ?? field.name))
    .map((field) => ({
      field: field.name,
      label: field.label ?? field.name,
      source: field.source ?? field.name,
      reason: "missing_ticket_field",
    }));
}

function isTicketFieldSource(source) {
  if (!source) {
    return false;
  }

  if (ticketFieldSources.has(source)) {
    return true;
  }

  return source.startsWith("ocrCandidates.");
}

function getLowConfidenceWarnings(extracted) {
  if (extracted?.manualOverridesApplied) {
    return [];
  }

  const confidence = extracted?.ocrConfidence ?? {};
  return Object.entries(confidenceThresholds)
    .filter(([field, threshold]) => {
      if (isMissing(extracted?.[field])) {
        return false;
      }

      const value = Number(confidence[field]);
      return Number.isFinite(value) && value < threshold;
    })
    .map(([field, threshold]) => ({
      field,
      confidence: Number(confidence[field]),
      threshold,
    }));
}

function normalizeCandidateList(values, currentValue) {
  const current = normalizeCandidateValue(currentValue);
  return [...new Set(toArray(values).map(normalizeCandidateValue).filter(Boolean))]
    .filter((value) => value !== current)
    .slice(0, Math.max(0, getBillingPortalVariantMaxAttempts() - 1));
}

function buildAttemptSignature(context) {
  return JSON.stringify({
    rfcEmisor: normalizeCandidateValue(context?.rfcEmisor),
    folio: normalizeCandidateValue(context?.folio),
    ticketId: normalizeCandidateValue(context?.ticketId),
    codigoFacturacion: normalizeCandidateValue(context?.codigoFacturacion),
    monto: normalizeCandidateValue(context?.monto),
    fecha: normalizeCandidateValue(context?.fecha ?? context?.ticketDate),
    permisoCre: normalizeCandidateValue(context?.permisoCre),
  });
}

function buildVariantFields(baseContext, candidateContext, candidateFields = {}) {
  return Object.fromEntries(
    Object.keys(candidateFields ?? {})
      .filter((field) => !isMissing(candidateContext[field]))
      .filter((field) => normalizeCandidateValue(baseContext?.[field]) !== normalizeCandidateValue(candidateContext[field]))
      .map((field) => [field, {
        original: baseContext?.[field] ?? null,
        value: candidateContext[field],
        source: "ocrResolution.candidateSets",
      }]),
  );
}

function removeMissingValues(value = {}) {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([, entry]) => !isMissing(entry)));
}

function pickPortalCandidateFields(value = {}) {
  const allowed = new Set([
    "folio",
    "ticketId",
    "codigoFacturacion",
    "fecha",
    "monto",
    "permisoCre",
    "sucursal",
    "serie",
    "token",
    "terminal",
    "webId",
  ]);
  return Object.fromEntries(
    Object.entries(removeMissingValues(value)).filter(([field]) => allowed.has(field)),
  );
}

function normalizeCandidateValue(value) {
  const text = String(value ?? "").trim();
  return text ? text.toUpperCase() : null;
}

function toArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (isMissing(value)) {
    return [];
  }

  return [value];
}

function firstArrayValue(value) {
  return Array.isArray(value) && value.length ? value[0] : value;
}

function isMissing(value) {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function firstString(...values) {
  for (const val of values) {
    if (typeof val === "string" && val.trim() !== "") {
      return val;
    }
  }
  return null;
}

function hasPortalCandidate(value) {
  return Boolean(
    firstString(value?.aiPortalUrl) ||
      firstString(value?.portalCandidateUrl) ||
      firstString(value?.portalUrl) ||
      firstString(value?.portalCandidates?.[0]?.url),
  );
}
