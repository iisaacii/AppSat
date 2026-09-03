import { SAT_CFDI_CATALOG_POLICY } from "./sat-cfdi-catalog.mjs";

export function buildFiscalComplianceContext(taxProfile = {}) {
  const rfc = normalizeText(taxProfile?.rfc).toUpperCase();
  const personType = inferPersonTypeFromRfc(rfc);
  const fiscalRegimeCodes = normalizeFiscalRegimeCodes(taxProfile);
  const expectedFiscalRegimeCode = fiscalRegimeCodes[0] ?? null;
  const expectedCfdiUseCode = extractLeadingCode(taxProfile?.cfdiUse);
  const regime = expectedFiscalRegimeCode
    ? SAT_CFDI_CATALOG_POLICY.regimeCatalog[expectedFiscalRegimeCode] ?? null
    : null;
  const cfdiUse = expectedCfdiUseCode ? SAT_CFDI_CATALOG_POLICY.cfdiUseCatalog[expectedCfdiUseCode] ?? null : null;
  const errors = [];
  const warnings = [];

  if (!rfc) {
    errors.push(buildIssue("tax_profile_rfc_missing", "El perfil fiscal no tiene RFC."));
  }

  if (!personType && rfc) {
    errors.push(buildIssue("tax_profile_rfc_invalid_shape", "El RFC no permite inferir si es persona fisica o moral."));
  }

  if (!expectedFiscalRegimeCode) {
    errors.push(buildIssue("tax_profile_fiscal_regime_missing", "El perfil fiscal no tiene regimen fiscal."));
  } else if (!regime) {
    errors.push(
      buildIssue(
        "tax_profile_fiscal_regime_unknown",
        `El regimen fiscal ${expectedFiscalRegimeCode} no existe en el catalogo local CFDI.`,
      ),
    );
  } else if (personType && !regime.personTypes.includes(personType)) {
    errors.push(
      buildIssue(
        "tax_profile_regime_person_type_mismatch",
        `El regimen ${expectedFiscalRegimeCode} no corresponde a persona ${personType}.`,
      ),
    );
  }

  if (!expectedCfdiUseCode) {
    errors.push(buildIssue("tax_profile_cfdi_use_missing", "El perfil fiscal no tiene uso CFDI."));
  } else if (!cfdiUse) {
    errors.push(
      buildIssue("tax_profile_cfdi_use_unknown", `El uso CFDI ${expectedCfdiUseCode} no existe en el catalogo local CFDI.`),
    );
  } else {
    if (personType && !cfdiUse.personTypes.includes(personType)) {
      errors.push(
        buildIssue(
          "tax_profile_cfdi_use_person_type_mismatch",
          `El uso CFDI ${expectedCfdiUseCode} no corresponde a persona ${personType}.`,
        ),
      );
    }

    if (
      expectedFiscalRegimeCode &&
      Array.isArray(cfdiUse.allowedRegimeCodes) &&
      !cfdiUse.allowedRegimeCodes.includes(expectedFiscalRegimeCode)
    ) {
      errors.push(
        buildIssue(
          "cfdi_use_not_supported_by_regime",
          `El uso CFDI ${expectedCfdiUseCode} no esta permitido para el regimen ${expectedFiscalRegimeCode}.`,
        ),
      );
    }
  }

  if (fiscalRegimeCodes.length > 1) {
    warnings.push({
      reason: "multiple_tax_regimes_detected",
      message: "El perfil trae varios regimenes; el primero se usa como regimen esperado para este job.",
      fiscalRegimeCodes,
    });
  }

  const blocked = errors.length > 0;
  const allowedPortalFiscalRegimeCodes = fiscalRegimeCodes.length ? fiscalRegimeCodes : [];
  const allowedPortalCfdiUseCodes = expectedCfdiUseCode ? [expectedCfdiUseCode] : [];

  return {
    catalogVersion: SAT_CFDI_CATALOG_POLICY.catalogVersion,
    catalogUpdatedAt: SAT_CFDI_CATALOG_POLICY.updatedAt,
    ready: !blocked,
    blocked,
    reason: errors[0]?.reason ?? "fiscal_compliance_ready",
    statusMessage: errors[0]?.message ?? "Perfil fiscal compatible con validaciones locales CFDI",
    personType,
    rfc,
    expectedFiscalRegime: expectedFiscalRegimeCode
      ? {
          code: expectedFiscalRegimeCode,
          label: regime?.description ?? normalizeText(taxProfile?.fiscalRegime),
          profileValue: normalizeText(taxProfile?.fiscalRegime),
        }
      : null,
    fiscalRegimeCodes,
    expectedCfdiUse: expectedCfdiUseCode
      ? {
          code: expectedCfdiUseCode,
          label: cfdiUse?.description ?? normalizeText(taxProfile?.cfdiUse),
          profileValue: normalizeText(taxProfile?.cfdiUse),
        }
      : null,
    allowedPortalFiscalRegimeCodes,
    allowedPortalCfdiUseCodes,
    canSubstituteFiscalRegime: false,
    canSubstituteCfdiUse: false,
    portalMissingFiscalRegimeReason: "tax_regime_not_available",
    portalMissingCfdiUseReason: "cfdi_use_not_available",
    errors,
    warnings,
  };
}

export function isFiscalComplianceBlocking(compliance) {
  return compliance?.blocked === true;
}

export function inferPersonTypeFromRfc(rfc) {
  const normalized = normalizeText(rfc).toUpperCase();

  if (/^[A-Z&]{4}\d{6}[A-Z0-9]{3}$/.test(normalized)) {
    return "fisica";
  }

  if (/^[A-Z&]{3}\d{6}[A-Z0-9]{3}$/.test(normalized)) {
    return "moral";
  }

  return null;
}

export function extractLeadingCode(value) {
  const text = normalizeText(value).toUpperCase();
  return text.match(/^[A-Z0-9]+/)?.[0] ?? null;
}

function normalizeFiscalRegimeCodes(profile = {}) {
  profile = profile ?? {};

  const rawValues = [
    ...(Array.isArray(profile.fiscalRegimes) ? profile.fiscalRegimes : []),
    ...(Array.isArray(profile.regimenesFiscales) ? profile.regimenesFiscales : []),
    profile.fiscalRegime,
    profile.regimenFiscal,
  ];

  return [...new Set(rawValues.map(extractLeadingCode).filter(Boolean))];
}

function buildIssue(reason, message) {
  return {
    reason,
    message,
    severity: "blocking",
  };
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
