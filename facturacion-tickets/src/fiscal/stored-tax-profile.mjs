import { normalizeTaxProfile } from "../contracts/factura-job-contract.mjs";

export function normalizeStoredTaxProfile(data = {}) {
  const profile = data?.taxProfile ?? {};
  const fiscalRegime = clean(
    profile.fiscalRegime ?? data?.regimenFiscal ?? firstString(data?.regimenesFiscales),
  );

  const normalized = normalizeTaxProfile({
    rfc: profile.rfc ?? data?.rfc,
    legalName: profile.legalName ?? data?.nombre,
    email: profile.email ?? data?.email,
    fiscalRegime,
    fiscalRegimes: profile.fiscalRegimes ?? data?.regimenesFiscales ?? fiscalRegime,
    cfdiUse: profile.cfdiUse ?? data?.usoCfdi,
    postalCode: profile.postalCode ?? data?.codigoPostal,
    street: profile.street ?? data?.calle,
    exteriorNumber: profile.exteriorNumber ?? data?.ext,
    interiorNumber: profile.interiorNumber ?? data?.int,
    neighborhood: profile.neighborhood ?? data?.colonia,
    municipality: profile.municipality ?? data?.municipio,
    state: profile.state ?? data?.estado,
    country: profile.country ?? data?.pais ?? "MEXICO",
  });

  return normalized.rfc || normalized.legalName ? normalized : null;
}

function firstString(value) {
  return Array.isArray(value) && value.length ? value[0] : undefined;
}

function clean(value) {
  return String(value ?? "").trim();
}
