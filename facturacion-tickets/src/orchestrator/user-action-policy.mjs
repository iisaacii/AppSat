import { buildFlutterWebviewHandoff } from "../user-action/flutter-webview-handoff.mjs";

export const USER_ACTION_STATUS = {
  REQUIRED: "user_action_required",
  RESOLVED: "resolved",
};

export const USER_ACTION_REASONS = {
  OCR_REVIEW_REQUIRED: "ocr_review_required",
  TICKET_DATA_REJECTED: "ticket_data_rejected",
  TICKET_ALREADY_INVOICED: "ticket_already_invoiced",
  CAPTCHA_REQUIRED: "captcha_required",
  LOGIN_REQUIRED: "login_required",
  PORTAL_BLOCKED: "portal_blocked",
  MANUAL_PORTAL_REQUIRED: "manual_portal_required",
};

const HARD_MANUAL_REASONS = new Set([
  USER_ACTION_REASONS.CAPTCHA_REQUIRED,
  USER_ACTION_REASONS.LOGIN_REQUIRED,
  USER_ACTION_REASONS.PORTAL_BLOCKED,
  "captcha_detected",
  "login_required",
  "bot_protection_detected",
  "portal_access_blocked",
  "cloudflare_blocked",
  "access_denied",
  "http_403",
  "forbidden",
  "modal_blocking",
  "blocking_modal",
  "modal_required",
]);

const DATA_REVIEW_REASONS = new Set([
  USER_ACTION_REASONS.OCR_REVIEW_REQUIRED,
  USER_ACTION_REASONS.TICKET_DATA_REJECTED,
  "ticket_not_found",
  "ticket_validation_rejected",
  "invalid_ticket_data",
  "portal_field_validation_failed",
  "ai_action_execution_failed",
  "ai_max_turns_reached",
  "stagehand_learning_failed",
  "stagehand_replay_failed",
]);

export function buildResolvedAlreadyInvoicedResult({
  job = {},
  extracted = {},
  portalRunResult = {},
  template = null,
  existingCfdi = null,
} = {}) {
  const message = firstString(
    portalRunResult.statusMessage,
    portalRunResult.portalMessage,
    "El portal indica que este ticket ya fue facturado.",
  );
  const cfdi = existingCfdi ?? buildExistingCfdiFromJob(job);

  return {
    status: USER_ACTION_STATUS.RESOLVED,
    reason: USER_ACTION_REASONS.TICKET_ALREADY_INVOICED,
    resolvedReason: USER_ACTION_REASONS.TICKET_ALREADY_INVOICED,
    resolvedAt: new Date().toISOString(),
    statusMessage: cfdi
      ? "El ticket ya estaba facturado. Se puede mostrar la factura guardada."
      : message,
    userAction: {
      status: USER_ACTION_STATUS.RESOLVED,
      reason: USER_ACTION_REASONS.TICKET_ALREADY_INVOICED,
      title: "Ticket ya facturado",
      message,
      resolution: cfdi ? "existing_cfdi_available" : "portal_message_acknowledged",
      existingCfdi: cfdi,
      evidence: buildEvidence(portalRunResult),
      checkpoint: buildCheckpoint({ job, extracted, portalRunResult, template }),
    },
    fallbackResult: null,
    error: null,
  };
}

export function buildUserActionRequiredResult({
  reason,
  statusMessage,
  job = {},
  extracted = {},
  portalRunResult = {},
  template = null,
  failure = null,
  editableFields = null,
} = {}) {
  const normalizedReason = normalizeUserActionReason(reason ?? portalRunResult.reason ?? failure?.reason);
  const portalMessage = firstString(
    statusMessage,
    portalRunResult.statusMessage,
    portalRunResult.portalMessage,
    failure?.statusMessage,
    defaultMessageForReason(normalizedReason),
  );
  const message = normalizeUserFacingMessage(normalizedReason, portalMessage);

  const ocrConfirmed =
    job?.ocrReviewConfirmed === true ||
    job?.ocrReview?.status === "confirmed" ||
    job?.ocrReview?.confirmed === true ||
    (job?.manualOverrides && Object.keys(job.manualOverrides).length > 0);

  const isOcrReviewLoop = normalizedReason === USER_ACTION_REASONS.OCR_REVIEW_REQUIRED && ocrConfirmed;
  const isTicketRejectedLoop = normalizedReason === USER_ACTION_REASONS.TICKET_DATA_REJECTED && ocrConfirmed;

  if (isOcrReviewLoop || isTicketRejectedLoop) {
    const fallbackMessage = isOcrReviewLoop
      ? "El ticket no contiene los datos obligatorios para facturar (RFC, fecha o monto) o no es un ticket valido."
      : "El portal indico que el ticket es invalido o no facturable.";

    return {
      status: "failed",
      reason: "ticket_unbillable",
      statusMessage: portalMessage || fallbackMessage,
      error: portalMessage || fallbackMessage,
      userAction: null,
    };
  }

  const manualCheckpoint = isManualCheckpointReason(normalizedReason);
  const fields = normalizeEditableFields(
    editableFields ?? buildEditableFields({ reason: normalizedReason, extracted, portalRunResult }),
  );
  const checkpoint = buildCheckpoint({ job, extracted, portalRunResult, template });
  const mobileHandoff = manualCheckpoint
    ? buildFlutterWebviewHandoff({
        reason: normalizedReason,
        checkpoint,
        template,
        taxProfile: job.taxProfile ?? {},
        editableFields: fields,
        portalMessage: firstString(portalRunResult.portalMessage, portalRunResult.statusMessage, null),
      })
    : null;

  return {
    status: "needs_user_action",
    reason: normalizedReason,
    statusMessage: message,
    userAction: {
      status: USER_ACTION_STATUS.REQUIRED,
      reason: normalizedReason,
      title: titleForReason(normalizedReason),
      message,
      expectedNextStep: manualCheckpoint ? "resume_interactive_checkpoint" : "review_and_retry",
      editableFields: fields,
      portalMessage: firstString(portalRunResult.portalMessage, portalRunResult.statusMessage, null),
      portalMessages: Array.isArray(portalRunResult.portalMessages) ? portalRunResult.portalMessages : [],
      evidence: buildEvidence(portalRunResult),
      checkpoint,
      mobileHandoff,
    },
    error: null,
  };
}

export function normalizeUserActionReason(reason) {
  if (reason === USER_ACTION_REASONS.TICKET_ALREADY_INVOICED || reason === "already_invoiced") {
    return USER_ACTION_REASONS.TICKET_ALREADY_INVOICED;
  }

  if (HARD_MANUAL_REASONS.has(reason)) {
    if (String(reason).includes("login")) {
      return USER_ACTION_REASONS.LOGIN_REQUIRED;
    }
    if (String(reason).includes("captcha")) {
      return USER_ACTION_REASONS.CAPTCHA_REQUIRED;
    }
    return USER_ACTION_REASONS.PORTAL_BLOCKED;
  }

  if (DATA_REVIEW_REASONS.has(reason)) {
    return reason === USER_ACTION_REASONS.OCR_REVIEW_REQUIRED
      ? USER_ACTION_REASONS.OCR_REVIEW_REQUIRED
      : USER_ACTION_REASONS.TICKET_DATA_REJECTED;
  }

  if (reason === "portal_template_missing" || reason === "unknown_emitter" || reason === "ai_navigation_unresolved") {
    return USER_ACTION_REASONS.MANUAL_PORTAL_REQUIRED;
  }

  return reason || USER_ACTION_REASONS.MANUAL_PORTAL_REQUIRED;
}

export function isAlreadyInvoicedReason(reason) {
  return normalizeUserActionReason(reason) === USER_ACTION_REASONS.TICKET_ALREADY_INVOICED;
}

function buildEditableFields({ reason, extracted = {}, portalRunResult = {} }) {
  if (
    reason === USER_ACTION_REASONS.CAPTCHA_REQUIRED ||
    reason === USER_ACTION_REASONS.LOGIN_REQUIRED ||
    reason === USER_ACTION_REASONS.PORTAL_BLOCKED
  ) {
    return [];
  }

  const baseFields = [
    field("rfcEmisor", extracted.rfcEmisor, "RFC emisor"),
    field("folio", extracted.folio, "Folio/ticket"),
    field("codigoFacturacion", extracted.codigoFacturacion, "Codigo de facturacion"),
    field("ticketId", extracted.ticketId ?? extracted.ocrCandidates?.ticketId, "ID de ticket"),
    field("permisoCre", extracted.permisoCre ?? extracted.ocrCandidates?.permisoCre, "Permiso CRE"),
    field("estacionCodigo", extracted.estacionCodigo ?? extracted.ocrCandidates?.estacionCodigo, "Codigo de estacion"),
    field("estacionNombre", extracted.estacionNombre ?? extracted.ocrCandidates?.estacionNombre, "Nombre de estacion"),
    field("fecha", extracted.fecha, "Fecha"),
    field("monto", extracted.monto, "Monto"),
    field("sucursal", extracted.sucursal, "Sucursal"),
    field("serie", extracted.serie, "Serie"),
    field("token", extracted.token, "Token"),
    field("terminal", extracted.terminal ?? extracted.ocrCandidates?.terminal, "Terminal"),
    field("webId", extracted.webId ?? extracted.ocrCandidates?.webId, "Web ID"),
  ];
  const missing = toArray(portalRunResult.missingFields)
    .map((item) => (typeof item === "string" ? item : item?.name))
    .filter(Boolean);

  if (!missing.length) {
    return baseFields.filter((item) => item.value !== null && item.value !== undefined && item.value !== "");
  }

  const requestedFields = baseFields.filter((item) => missing.includes(item.key));

  return requestedFields.length
    ? requestedFields
    : baseFields.filter((item) => item.value !== null && item.value !== undefined && item.value !== "");
}

function buildEvidence(portalRunResult = {}) {
  const artifacts = portalRunResult.artifacts ?? {};

  return {
    screenshotPath: firstString(artifacts.screenshotPath, portalRunResult.screenshotPath, null),
    screenshotStoragePath: firstString(artifacts.screenshotStoragePath, null),
    screenshotUrl: firstString(artifacts.screenshotUrl, null),
    htmlPath: firstString(artifacts.htmlPath, portalRunResult.htmlPath, null),
    htmlStoragePath: firstString(artifacts.htmlStoragePath, null),
    htmlUrl: firstString(artifacts.htmlUrl, null),
  };
}

function buildCheckpoint({ job = {}, extracted = {}, portalRunResult = {}, template = null } = {}) {
  const artifacts = portalRunResult.artifacts ?? {};

  return {
    kind: "portal_checkpoint.v1",
    portalUrl: firstString(
      portalRunResult.currentUrl,
      portalRunResult.portalUrl,
      job.aiPortalUrl,
      job.portalCandidateUrl,
      job.portalUrl,
      template?.portalUrl,
      null,
    ),
    currentUrl: firstString(portalRunResult.currentUrl, null),
    templateId: template?.id ?? job.portalTemplateId ?? null,
    portalFamily: template?.portalFamily ?? job.portalFamily ?? null,
    portalName: template?.name ?? job.portalName ?? null,
    rfcEmisor: extracted.rfcEmisor ?? job.rfcEmisor ?? null,
    ticketData: {
      folio: extracted.folio ?? job.folio ?? null,
      ticketId: extracted.ticketId ?? extracted.ocrCandidates?.ticketId ?? null,
      fecha: extracted.fecha ?? job.fecha ?? null,
      monto: extracted.monto ?? job.monto ?? null,
      permisoCre: extracted.permisoCre ?? extracted.ocrCandidates?.permisoCre ?? job.permisoCre ?? null,
      codigoFacturacion: extracted.codigoFacturacion ?? job.codigoFacturacion ?? null,
      estacionCodigo: extracted.estacionCodigo ?? extracted.ocrCandidates?.estacionCodigo ?? null,
      estacionNombre: extracted.estacionNombre ?? extracted.ocrCandidates?.estacionNombre ?? null,
      sucursal: extracted.sucursal ?? extracted.ocrCandidates?.sucursal ?? job.sucursal ?? null,
      serie: extracted.serie ?? job.serie ?? null,
      token: extracted.token ?? job.token ?? null,
      terminal: extracted.terminal ?? extracted.ocrCandidates?.terminal ?? null,
      webId: extracted.webId ?? extracted.ocrCandidates?.webId ?? null,
    },
    taxProfileId: job.taxProfileId ?? null,
    reason: portalRunResult.reason ?? null,
    screenshotPath: firstString(artifacts.screenshotPath, artifacts.screenshotStoragePath, null),
    htmlPath: firstString(artifacts.htmlPath, artifacts.htmlStoragePath, null),
  };
}

function buildExistingCfdiFromJob(job = {}) {
  if (!job.resultXmlStoragePath && !job.resultPdfStoragePath && !job.resultXmlUrl && !job.resultPdfUrl) {
    return null;
  }

  return {
    resultXmlUrl: job.resultXmlUrl ?? null,
    resultPdfUrl: job.resultPdfUrl ?? null,
    resultXmlStoragePath: job.resultXmlStoragePath ?? null,
    resultPdfStoragePath: job.resultPdfStoragePath ?? null,
  };
}

function isManualCheckpointReason(reason) {
  return [
    USER_ACTION_REASONS.CAPTCHA_REQUIRED,
    USER_ACTION_REASONS.LOGIN_REQUIRED,
    USER_ACTION_REASONS.PORTAL_BLOCKED,
    USER_ACTION_REASONS.MANUAL_PORTAL_REQUIRED,
  ].includes(reason);
}

function defaultMessageForReason(reason) {
  if (reason === USER_ACTION_REASONS.OCR_REVIEW_REQUIRED) {
    return "Hay datos del ticket que necesitan revision antes de facturar.";
  }
  if (reason === USER_ACTION_REASONS.TICKET_DATA_REJECTED) {
    return "El portal rechazo los datos del ticket. Revisa los campos detectados.";
  }
  if (reason === USER_ACTION_REASONS.CAPTCHA_REQUIRED) {
    return "El portal requiere CAPTCHA. Se guardo un checkpoint para continuar manualmente.";
  }
  if (reason === USER_ACTION_REASONS.LOGIN_REQUIRED) {
    return "El portal requiere login. Se guardo un checkpoint para continuar manualmente.";
  }
  if (reason === USER_ACTION_REASONS.PORTAL_BLOCKED) {
    return "El portal bloqueo la automatizacion. Se guardo evidencia para continuar manualmente.";
  }
  return "El portal requiere intervencion del usuario.";
}

function normalizeUserFacingMessage(reason, message) {
  const raw = firstString(message, defaultMessageForReason(reason));
  const lower = raw.toLowerCase();

  if (reason === USER_ACTION_REASONS.CAPTCHA_REQUIRED && lower.includes("no est")) {
    return "El portal requiere CAPTCHA. Continúa en el portal para resolverlo y descargar la factura.";
  }

  if (reason === USER_ACTION_REASONS.LOGIN_REQUIRED && lower.includes("no est")) {
    return "El portal requiere iniciar sesión o completar una cuenta. Continúa en el portal para terminar.";
  }

  return raw;
}

function titleForReason(reason) {
  if (reason === USER_ACTION_REASONS.OCR_REVIEW_REQUIRED) {
    return "Revisar datos del ticket";
  }
  if (reason === USER_ACTION_REASONS.TICKET_DATA_REJECTED) {
    return "Datos rechazados por el portal";
  }
  if (reason === USER_ACTION_REASONS.CAPTCHA_REQUIRED) {
    return "CAPTCHA requerido";
  }
  if (reason === USER_ACTION_REASONS.LOGIN_REQUIRED) {
    return "Login requerido";
  }
  if (reason === USER_ACTION_REASONS.PORTAL_BLOCKED) {
    return "Portal bloqueado";
  }
  return "Intervencion requerida";
}

function field(key, value, label) {
  return {
    key,
    label,
    value: value ?? null,
  };
}

function normalizeEditableFields(fields) {
  return toArray(fields).map((item) => {
    if (typeof item === "string") {
      return field(item, null, labelFromKey(item));
    }

    const key = item?.key ?? item?.name ?? item?.field ?? null;

    return {
      key,
      label: item?.label ?? item?.description ?? labelFromKey(key),
      value: item?.value ?? null,
      expectedValue: item?.expectedValue ?? null,
      confidence: item?.confidence ?? null,
      reason: item?.reason ?? null,
      required: item?.required ?? false,
    };
  });
}

function labelFromKey(key) {
  const labels = {
    rfcEmisor: "RFC emisor",
    folio: "Folio/ticket",
    codigoFacturacion: "Codigo de facturacion",
    ticketId: "ID de ticket",
    permisoCre: "Permiso CRE",
    estacionCodigo: "Codigo de estacion",
    estacionNombre: "Nombre de estacion",
    fecha: "Fecha",
    monto: "Monto",
    sucursal: "Sucursal",
    serie: "Serie",
    token: "Token",
    terminal: "Terminal",
    webId: "Web ID",
  };

  return labels[key] ?? key ?? "Campo";
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}
