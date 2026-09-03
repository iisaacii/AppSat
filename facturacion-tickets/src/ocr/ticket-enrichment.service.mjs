const fuelBrandPattern =
  /\b(G500|PEMEX|PETRO\s*SEVEN|HIDROSINA|BP|SHELL|MOBIL|REPSOL|VALERO|ARCO|TOTAL\s*ENERGIES|GULF|AKRON|OXXO\s*GAS)\b/i;
const fuelTextPattern =
  /\b(PERMISO\s*C\.?R\.?E\.?|CRE\b|EXP\/ES|LITR(?:O|OS|S)?|COMBUSTIBLE|G\s*SUPER|MAGNA|PREMIUM|DIESEL|GASOLINA|ESTACION\s+DE\s+SERVICIO|TERMINAL|BOMBA)\b/i;
const directPermisoCrePattern =
  /\bP[L1I]\s*[\/\\|\-\s]?\s*(\d{3,6})\s*[\/\\|\-\s]?\s*E[XK][Pp]\s*[\/\\|\-\s]?\s*E[S5]\s*[\/\\|\-\s]?\s*(20\d{2})\b/gi;
const labeledPermisoCrePattern =
  /(?:PERMISO\s*(?:C\.?\s*R\.?\s*E\.?|CRE)?|P\.?\s*C\.?\s*R\.?\s*E\.?)\s*[:#-]?\s*([A-Z0-9/\\|\-\s]{8,40})/gi;

export function enrichTicketExtraction(extracted = {}) {
  const rawText = [
    extracted.ocrText,
    extracted.ocrTextPreview,
    ...(Array.isArray(extracted.qrValues) ? extracted.qrValues : []),
    ...(Array.isArray(extracted.ocrCandidates?.qrValues) ? extracted.ocrCandidates.qrValues : []),
  ]
    .filter(Boolean)
    .join("\n");
  const ocrCandidates = { ...(extracted.ocrCandidates ?? {}) };
  const fuelProfile = detectFuelTicket({ extracted, rawText });
  const permisoCreResult = extractPermisoCreCandidates(rawText, { extracted, fuelProfile });
  const confidencePatch = { ...(extracted.ocrConfidence ?? {}) };
  const enrichment = {
    ...(extracted.ticketEnrichment ?? {}),
    detectedAt: new Date().toISOString(),
    fuel: fuelProfile,
    permisoCre: permisoCreResult,
  };

  if (permisoCreResult.value) {
    ocrCandidates.permisoCre = ocrCandidates.permisoCre ?? permisoCreResult.value;
    ocrCandidates.permisoCreCandidates = uniqueStrings([
      permisoCreResult.value,
      ...permisoCreResult.candidates.map((candidate) => candidate.value),
      ...(Array.isArray(ocrCandidates.permisoCreCandidates) ? ocrCandidates.permisoCreCandidates : []),
    ]);
    confidencePatch.permisoCre = Math.max(Number(confidencePatch.permisoCre ?? 0), permisoCreResult.confidence);
  }

  if (fuelProfile.isFuel) {
    ocrCandidates.businessDomain = ocrCandidates.businessDomain ?? "fuel";
    ocrCandidates.ticketKind = ocrCandidates.ticketKind ?? "fuel";
  }

  for (const [key, value] of Object.entries(permisoCreResult.relatedFields)) {
    if (value && !ocrCandidates[key]) {
      ocrCandidates[key] = value;
    }
  }

  return {
    ...extracted,
    businessDomain: extracted.businessDomain ?? (fuelProfile.isFuel ? "fuel" : null),
    permisoCre: extracted.permisoCre ?? permisoCreResult.value ?? null,
    estacionCodigo: extracted.estacionCodigo ?? permisoCreResult.relatedFields.estacionCodigo ?? null,
    estacionNombre: extracted.estacionNombre ?? permisoCreResult.relatedFields.estacionNombre ?? null,
    ticketEnrichment: enrichment,
    ocrCandidates,
    ocrConfidence: confidencePatch,
  };
}

export function normalizePermisoCre(value) {
  const raw = String(value ?? "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[|\\]/g, "/")
    .replace(/\s+/g, " ")
    .trim();

  if (!raw) {
    return null;
  }

  const compact = raw
    .replace(/[^\dA-Z/ -]/g, "")
    .replace(/\bP[1I]\b/g, "PL")
    .replace(/\bE5\b/g, "ES")
    .replace(/\bEKP\b/g, "EXP");
  const match = compact.match(/\bP[L1I]\s*[\/\-\s]?\s*(\d{3,6})\s*[\/\-\s]?\s*E[XK]P\s*[\/\-\s]?\s*E[S5]\s*[\/\-\s]?\s*(20\d{2})\b/);

  if (!match) {
    return null;
  }

  return `PL/${String(Number(match[1]))}/EXP/ES/${match[2]}`;
}

export function extractPermisoCreCandidates(rawText, { extracted = {}, fuelProfile = null } = {}) {
  const text = normalizeText(rawText);
  const candidates = [];
  const relatedFields = {
    estacionCodigo: firstStationCode(text, extracted),
    estacionNombre: firstStationName(rawText),
  };

  collectDirectCandidates(text, candidates);
  collectLabeledCandidates(text, candidates);

  const inferred = inferPermisoCreFromStationCode(text, relatedFields.estacionCodigo);
  if (inferred) {
    candidates.push(inferred);
  }

  const ranked = rankCandidates(candidates);
  const best = ranked[0] ?? null;

  return {
    value: best?.value ?? null,
    confidence: best?.confidence ?? 0,
    source: best?.source ?? null,
    needsReview:
      Boolean(fuelProfile?.isFuel) &&
      (!best?.value || best.confidence < 0.75 || best.source === "station_code_inference"),
    candidates: ranked,
    relatedFields,
  };
}

function detectFuelTicket({ extracted = {}, rawText = "" }) {
  const haystack = [
    rawText,
    extracted.ocrCandidates?.emisorNombre,
    extracted.ocrCandidates?.nombreComercial,
    extracted.ocrCandidates?.razonSocial,
  ]
    .filter(Boolean)
    .join("\n");
  const matchedBrand = haystack.match(fuelBrandPattern)?.[1] ?? null;
  const hasFuelText = fuelTextPattern.test(haystack);

  return {
    isFuel: Boolean(matchedBrand || hasFuelText),
    matchedBrand,
    signals: [
      ...(matchedBrand ? [{ type: "brand", value: matchedBrand }] : []),
      ...(hasFuelText ? [{ type: "ticket_text", value: "fuel_terms" }] : []),
    ],
  };
}

function collectDirectCandidates(text, candidates) {
  directPermisoCrePattern.lastIndex = 0;
  for (const match of text.matchAll(directPermisoCrePattern)) {
    const value = normalizePermisoCre(match[0]);
    if (value) {
      candidates.push({
        value,
        raw: match[0],
        source: "ocr_regex",
        confidence: 0.9,
      });
    }
  }
}

function collectLabeledCandidates(text, candidates) {
  labeledPermisoCrePattern.lastIndex = 0;
  for (const match of text.matchAll(labeledPermisoCrePattern)) {
    const value = normalizePermisoCre(match[1]);
    if (value) {
      candidates.push({
        value,
        raw: match[0],
        source: "ocr_labeled_regex",
        confidence: 0.86,
      });
    }
  }
}

function inferPermisoCreFromStationCode(text, stationCode) {
  const codeDigits = String(stationCode ?? "").match(/P?0*(\d{4,6})\b/i)?.[1];

  if (!codeDigits) {
    return null;
  }

  const year = text.match(/\b(?:EXP\s*[/\-\s]?\s*ES|E[XK]P\s*[/\-\s]?\s*E[S5])\s*[/\-\s]?\s*(20\d{2})\b/i)?.[1];

  if (!year) {
    return null;
  }

  return {
    value: `PL/${Number(codeDigits)}/EXP/ES/${year}`,
    raw: `${stationCode} + EXP/ES/${year}`,
    source: "station_code_inference",
    confidence: 0.64,
  };
}

function firstStationCode(text, extracted) {
  return (
    extracted?.ocrCandidates?.estacionCodigo ??
    extracted?.ocrCandidates?.sucursal ??
    firstMatch(text, /\b(P0?\d{4,6})\b/) ??
    firstMatch(text, /\bESTACI[O0]N\s*[:#-]?\s*(P?0?\d{4,6})\b/) ??
    null
  );
}

function firstStationName(rawText) {
  const text = String(rawText ?? "");
  return (
    firstMatch(text, /\|P0?\d{4,6}\|([^|]{3,80})\|/) ??
    firstMatch(text, /\b(?:ESTACI[OÓ]N|SUCURSAL)\s*[:#-]?\s*([A-ZÁÉÍÓÚÑ0-9 .-]{3,80})/i) ??
    null
  );
}

function rankCandidates(candidates) {
  const deduped = new Map();

  for (const candidate of candidates) {
    const existing = deduped.get(candidate.value);

    if (!existing || candidate.confidence > existing.confidence) {
      deduped.set(candidate.value, candidate);
    }
  }

  return [...deduped.values()].sort((a, b) => b.confidence - a.confidence);
}

function firstMatch(text, pattern) {
  return String(text ?? "").match(pattern)?.[1]?.trim() ?? null;
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function normalizeText(value) {
  return String(value ?? "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[ \t]+/g, " ");
}
