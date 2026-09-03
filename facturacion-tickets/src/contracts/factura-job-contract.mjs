import { buildFiscalComplianceContext } from "../fiscal/fiscal-compliance.service.mjs";
import { getFirebaseStorageBucketName } from "../config/env.mjs";
import { assertTrustedTicketFileUrl } from "../security/external-url-policy.mjs";

export const FACTURA_JOB_CONTRACT_VERSION = "factura-job.v1";

export const FACTURA_JOB_REQUIRED_FIELDS = [
  "id",
  "uid",
  "ticketFileUrl",
  "rfcReceptor",
  "workflowStage",
  "status",
];

export const FACTURA_JOB_CLIENT_CREATE_FIELDS = [
  "contractVersion",
  "id",
  "uid",
  "ticketFileUrl",
  "rfcReceptor",
  "taxProfileId",
  "taxProfile",
  "source",
  "ocrReviewConfirmed",
  "workflowStage",
  "status",
  "statusMessage",
  "portalFinalSubmitApproved",
  "createdAt",
  "updatedAt",
];

export const TAX_PROFILE_REQUIRED_FIELDS = [
  "rfc",
  "legalName",
  "fiscalRegime",
  "cfdiUse",
  "postalCode",
  "street",
  "exteriorNumber",
  "neighborhood",
  "municipality",
  "state",
];

export function buildFacturaJobCreatePayload({
  jobId,
  uid,
  ticketFileUrl,
  taxProfile = null,
  taxProfileId = null,
  source = "flutter_app",
  now = new Date(),
} = {}) {
  const normalizedTaxProfile = taxProfile ? normalizeTaxProfile(taxProfile) : null;
  const rfcReceptor = clean(normalizedTaxProfile?.rfc).toUpperCase();

  return {
    contractVersion: FACTURA_JOB_CONTRACT_VERSION,
    id: clean(jobId),
    uid: clean(uid),
    ticketFileUrl: clean(ticketFileUrl),
    rfcReceptor,
    taxProfileId: normalizedTaxProfile ? clean(taxProfileId) || "billing_lab_default" : null,
    taxProfile: normalizedTaxProfile,
    source,
    ocrReviewConfirmed: false,
    workflowStage: "ocr",
    status: "pending",
    statusMessage: "Ticket recibido",
    portalFinalSubmitApproved: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function validateFacturaJobCreatePayload(payload) {
  const errors = [];
  const warnings = [];

  if (!payload || typeof payload !== "object") {
    return {
      ok: false,
      errors: ["payload must be an object"],
      warnings,
    };
  }

  for (const field of FACTURA_JOB_REQUIRED_FIELDS) {
    if (isMissing(payload[field])) {
      errors.push(`missing ${field}`);
    }
  }

  if (payload.status && payload.status !== "pending") {
    errors.push("status must be pending on create");
  }

  if (payload.workflowStage !== "ocr") {
    errors.push("workflowStage must be ocr on create");
  }

  if (payload.ocrReviewConfirmed !== false) {
    errors.push("ocrReviewConfirmed must be false on create");
  }

  if (payload.portalFinalSubmitApproved !== false) {
    errors.push("portalFinalSubmitApproved must be false on create");
  }

  const unexpectedFields = Object.keys(payload).filter(
    (field) => !FACTURA_JOB_CLIENT_CREATE_FIELDS.includes(field),
  );
  if (unexpectedFields.length) {
    errors.push(`unexpected client create fields: ${unexpectedFields.join(", ")}`);
  }

  if (payload.ticketFileUrl && !isSupportedTicketUrl(payload.ticketFileUrl, payload.uid)) {
    errors.push("ticketFileUrl must be mock:// or the authenticated user's Firebase ticket URL");
  }

  if (!payload.taxProfile) {
    warnings.push("taxProfile missing; worker will try contribuyentes/billing_lab_default");
  } else {
    const profileErrors = validateTaxProfile(payload.taxProfile).map((error) => `taxProfile.${error}`);
    errors.push(...profileErrors);
  }

  if (payload.taxProfile?.rfc && payload.rfcReceptor && payload.taxProfile.rfc !== payload.rfcReceptor) {
    errors.push("rfcReceptor must match taxProfile.rfc");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

export function normalizeTaxProfile(profile = {}) {
  const fiscalRegimes = normalizeFiscalRegimes(profile);

  return {
    rfc: clean(profile.rfc).toUpperCase(),
    legalName: clean(profile.legalName),
    email: clean(profile.email),
    fiscalRegime: clean(profile.fiscalRegime),
    fiscalRegimes,
    cfdiUse: clean(profile.cfdiUse),
    postalCode: clean(profile.postalCode),
    street: clean(profile.street),
    exteriorNumber: clean(profile.exteriorNumber),
    interiorNumber: clean(profile.interiorNumber),
    neighborhood: clean(profile.neighborhood),
    municipality: clean(profile.municipality),
    state: clean(profile.state),
    country: clean(profile.country) || "MEXICO",
  };
}

export function validateTaxProfile(profile) {
  const errors = [];
  const normalized = normalizeTaxProfile(profile);

  for (const field of TAX_PROFILE_REQUIRED_FIELDS) {
    if (isMissing(normalized[field])) {
      errors.push(`missing ${field}`);
    }
  }

  if (normalized.rfc && !/^[A-Z&]{3,4}\d{6}[A-Z0-9]{3}$/.test(normalized.rfc)) {
    errors.push("rfc has invalid shape");
  }

  const fiscalCompliance = buildFiscalComplianceContext(normalized);
  errors.push(...fiscalCompliance.errors.map((error) => error.reason));

  return errors;
}

function normalizeFiscalRegimes(profile = {}) {
  profile = profile ?? {};

  const values = [
    ...(Array.isArray(profile.fiscalRegimes) ? profile.fiscalRegimes : []),
    ...(Array.isArray(profile.regimenesFiscales) ? profile.regimenesFiscales : []),
    profile.fiscalRegime,
  ]
    .map(clean)
    .filter(Boolean);

  return [...new Set(values)];
}

function isSupportedTicketUrl(value, uid) {
  if (String(value).startsWith("mock://")) {
    return true;
  }

  try {
    assertTrustedTicketFileUrl(value, {
      uid,
      bucketName: getFirebaseStorageBucketName(),
    });
    return true;
  } catch {
    return false;
  }
}

function isMissing(value) {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function clean(value) {
  return String(value ?? "").trim();
}
