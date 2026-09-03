import { GoogleAuth } from "google-auth-library";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { loadTrustedTicketImage } from "./ticket-image.service.mjs";

const visionEndpoint = "https://vision.googleapis.com/v1/images:annotate";
const authScopes = ["https://www.googleapis.com/auth/cloud-platform"];

export async function extractTicketData(ticketFileUrl, { uid } = {}) {
  if (!ticketFileUrl?.startsWith("http")) {
    throw new Error("Google Vision OCR requiere una URL descargable del ticket.");
  }

  const image = await loadTrustedTicketImage(ticketFileUrl, { uid });
  const ocrPasses = await detectTextMultipass(image);
  const extracted = mergeOcrPasses(ocrPasses);
  const text = extracted.ocrText;

  return {
    sourceType: "storage_image",
    ocrEngine: "google_vision",
    ocrText: text,
    ocrTextPreview: text.slice(0, 1200),
    ocrPasses: ocrPasses.map((pass) => ({
      name: pass.name,
      textLength: pass.text.length,
      fieldScore: scoreExtractedFields(pass.extracted),
    })),
    ...extracted,
  };
}

async function detectTextMultipass(image) {
  const variants = buildOcrImageVariants(image);
  const passes = [];

  for (const variant of variants) {
    const text = await detectText(variant.buffer.toString("base64"));
    passes.push({
      name: variant.name,
      text,
      extracted: extractFields(text),
    });
  }

  return passes;
}

async function detectText(content) {
  const auth = new GoogleAuth({ scopes: authScopes });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  const languageHints = getVisionLanguageHints();
  const imageContext = languageHints.length ? { languageHints } : undefined;

  const response = await fetch(visionEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.token ?? token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: [
        {
          image: { content },
          features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          ...(imageContext ? { imageContext } : {}),
        },
      ],
    }),
  });

  const body = await response.json();

  if (!response.ok) {
    throw new Error(`Google Vision OCR fallo: ${JSON.stringify(body.error ?? body)}`);
  }

  const result = body.responses?.[0];

  if (result?.error) {
    throw new Error(`Google Vision OCR fallo: ${JSON.stringify(result.error)}`);
  }

  return result?.fullTextAnnotation?.text ?? result?.textAnnotations?.[0]?.description ?? "";
}

function getVisionLanguageHints() {
  const raw = process.env.OCR_GOOGLE_VISION_LANGUAGE_HINTS;

  if (raw === undefined) {
    return [];
  }

  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildOcrImageVariants(image) {
  const variants = [{ name: "original", buffer: image.buffer }];

  if (process.env.OCR_GOOGLE_VISION_MULTIPASS === "false") {
    return variants;
  }

  const enhanced = buildHighContrastVariant(image);

  if (enhanced) {
    variants.push(enhanced);
  }

  return variants.slice(0, getOcrMaxPasses());
}

function getOcrMaxPasses() {
  const parsed = Number(process.env.OCR_GOOGLE_VISION_MAX_PASSES ?? 2);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 4) : 2;
}

function buildHighContrastVariant(image) {
  const decoded = decodeRasterImage(image);

  if (!decoded) {
    return null;
  }

  const png = new PNG({ width: decoded.width, height: decoded.height });

  for (let index = 0; index < decoded.data.length; index += 4) {
    const r = decoded.data[index];
    const g = decoded.data[index + 1];
    const b = decoded.data[index + 2];
    const alpha = decoded.data[index + 3] ?? 255;
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    const contrasted = clampByte((gray - 128) * 1.45 + 128);
    const sharpened = contrasted > 210 ? 255 : contrasted < 55 ? 0 : contrasted;

    png.data[index] = sharpened;
    png.data[index + 1] = sharpened;
    png.data[index + 2] = sharpened;
    png.data[index + 3] = alpha;
  }

  return {
    name: "grayscale_high_contrast",
    buffer: PNG.sync.write(png),
  };
}

function decodeRasterImage(image) {
  const contentType = image.contentType.toLowerCase();

  try {
    if (contentType.includes("png") || hasPngSignature(image.buffer)) {
      const decoded = PNG.sync.read(image.buffer);
      return {
        width: decoded.width,
        height: decoded.height,
        data: decoded.data,
      };
    }

    if (contentType.includes("jpeg") || contentType.includes("jpg") || hasJpegSignature(image.buffer)) {
      return jpeg.decode(image.buffer, { useTArray: true });
    }
  } catch {
    return null;
  }

  return null;
}

function hasPngSignature(buffer) {
  return buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
}

function hasJpegSignature(buffer) {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function mergeOcrPasses(passes) {
  const ranked = [...passes].sort(
    (a, b) =>
      scoreExtractedFields(b.extracted) - scoreExtractedFields(a.extracted) ||
      b.text.length - a.text.length,
  );
  const best = ranked[0] ?? {
    text: "",
    extracted: extractFields(""),
  };
  const merged = {
    ...best.extracted,
    ocrText: best.text,
    ocrCandidates: {
      ...(best.extracted.ocrCandidates ?? {}),
    },
    ocrConfidence: {
      ...(best.extracted.ocrConfidence ?? {}),
    },
  };

  for (const pass of ranked.slice(1)) {
    mergeMissingExtractionFields(merged, pass.extracted);
  }

  merged.ocrCandidates = mergeCandidateLists(merged.ocrCandidates, passes);
  merged.ocrCandidates.ocrPassBest = best.name;

  if (passes.length > 1) {
    merged.ocrCandidates.ocrPasses = passes.map((pass) => pass.name);
  }

  return merged;
}

function scoreExtractedFields(extracted = {}) {
  let score = 0;
  if (extracted.rfcEmisor) score += 4;
  if (extracted.fecha) score += 3;
  if (extracted.monto) score += 3;
  if (extracted.folio) score += 2;
  if (extracted.ocrCandidates?.ticketId) score += 2;
  if (extracted.ocrCandidates?.folioVenta) score += 2;
  if (extracted.ocrCandidates?.formaPago) score += 1;
  if (Array.isArray(extracted.ocrCandidates?.rfc)) score += Math.min(extracted.ocrCandidates.rfc.length, 3);
  return score;
}

function mergeMissingExtractionFields(target, source) {
  for (const field of ["rfcEmisor", "folio", "fecha", "monto"]) {
    if (isMissing(target[field]) && !isMissing(source[field])) {
      target[field] = source[field];
    }
  }

  for (const field of ["rfcEmisor", "folio", "fecha", "monto"]) {
    const confidence = source.ocrConfidence?.[field];
    if (!isMissing(source[field]) && (target[field] === source[field] || isMissing(target.ocrConfidence[field]))) {
      target.ocrConfidence[field] = Math.max(target.ocrConfidence[field] ?? 0, confidence ?? 0.55);
    }
  }

  target.ocrCandidates = {
    ...(source.ocrCandidates ?? {}),
    ...target.ocrCandidates,
  };
}

function mergeCandidateLists(baseCandidates = {}, passes) {
  const merged = { ...baseCandidates };
  const rfc = new Set(toArray(baseCandidates.rfc));
  const folioVentaAlternates = new Set(toArray(baseCandidates.folioVentaAlternates));
  const ticketIdAlternates = new Set(toArray(baseCandidates.ticketIdAlternates));

  for (const pass of passes) {
    const candidates = pass.extracted.ocrCandidates ?? {};
    for (const value of toArray(candidates.rfc)) rfc.add(value);
    for (const value of toArray(candidates.folioVentaAlternates)) folioVentaAlternates.add(value);
    for (const value of toArray(candidates.ticketIdAlternates)) ticketIdAlternates.add(value);

    if (isMissing(merged.folioVenta) && candidates.folioVenta) merged.folioVenta = candidates.folioVenta;
    if (isMissing(merged.ticketId) && candidates.ticketId) merged.ticketId = candidates.ticketId;
    if (isMissing(merged.fecha) && candidates.fecha) merged.fecha = candidates.fecha;
    if (isMissing(merged.monto) && candidates.monto) merged.monto = candidates.monto;
    if (isMissing(merged.formaPago) && candidates.formaPago) merged.formaPago = candidates.formaPago;
    if (isMissing(merged.formaPagoTexto) && candidates.formaPagoTexto) merged.formaPagoTexto = candidates.formaPagoTexto;
  }

  merged.rfc = [...rfc];
  merged.folioVentaAlternates = [...folioVentaAlternates];
  merged.ticketIdAlternates = [...ticketIdAlternates];
  return merged;
}

function toArray(value) {
  return Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined && item !== "") : [];
}

function isMissing(value) {
  return value === null || value === undefined || value === "";
}

export function extractFields(rawText) {
  const text = normalizeText(rawText);
  const rfcCandidates = extractRfcCandidates(text);
  const rfcEmisor = rfcCandidates.find((rfc) => !rfc.startsWith("XAXX")) ?? rfcCandidates[0] ?? null;
  const sevenTicket = extractSevenElevenTicketData(text);
  const fecha = extractDate(text);
  const monto = extractAmount(text);
  const folio = sevenTicket?.folio ?? extractFolio(text);
  const ocrCandidates = extractCandidates(text, {
    rfcCandidates,
    folio,
    fecha,
    monto,
    sevenTicket,
  });

  return {
    rfcEmisor,
    folio,
    fecha,
    monto,
    ocrCandidates,
    ocrConfidence: {
      rfcEmisor: rfcEmisor ? 0.82 : 0,
      folio: folio ? 0.66 : 0,
      fecha: fecha ? 0.7 : 0,
      monto: monto ? 0.68 : 0,
    },
  };
}

function normalizeText(value) {
  return value
    .toUpperCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[ \t]+/g, " ");
}

function extractRfcCandidates(text) {
  const canonicalMatches = [...text.matchAll(/[A-Z&Ñ0]{3,4}\d{6}[A-Z0-9]{3}/g)].map((match) => match[0]);
  const separatedMatches = [
    ...text.matchAll(/[A-Z&Ñ0]{3,4}[-\s.]?\d{2}[-\s.]?\d{2}[-\s.]?\d{2}[-\s.]?[A-Z0-9]{3}/g),
  ].map((match) => match[0]);

  return [
    ...new Set(
      [...canonicalMatches, ...separatedMatches]
        .map(normalizeRfcCandidate)
        .filter((candidate) => candidate !== null),
    ),
  ];
}

function normalizeRfcCandidate(value) {
  const compact = String(value ?? "").replace(/[^A-Z0-9&Ñ]/g, "");
  const match = compact.match(/^([A-Z&Ñ0]{3,4})(\d{6})([A-Z0-9]{3})$/);

  if (!match) {
    return null;
  }

  const prefix = match[1].replace(/0/g, "O");
  const candidate = `${prefix}${match[2]}${match[3]}`;

  return /^[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}$/.test(candidate) ? candidate : null;
}

function extractDate(text) {
  const isoDate = text.match(/(?<!\d)(20\d{2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})(?!\d)/);

  if (isoDate) {
    return buildValidIsoDate(isoDate[1], isoDate[2], isoDate[3]);
  }

  const slashDate = text.match(/(?<!\d)(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{2,4})(?!\d)/);

  if (slashDate) {
    const first = Number(slashDate[1]);
    const second = Number(slashDate[2]);
    const monthFirst = first <= 12 && second > 12;
    const day = monthFirst ? second : first;
    const month = monthFirst ? first : second;
    const year = slashDate[3].length === 2 ? `20${slashDate[3]}` : slashDate[3];
    return buildValidIsoDate(year, month, day);
  }

  return null;
}

function buildValidIsoDate(year, month, day) {
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso ? null : iso;
}

function extractAmount(text) {
  const ranked = rankAmountCandidates(text);

  if (ranked.length) {
    return ranked[0].value;
  }

  const amounts = [...text.matchAll(/(?:\$|MXN)\s*([0-9]{1,4}(?:[,.][0-9]{3})*(?:[,.]\d{2}))/g)]
    .map((match) => parseCurrency(match[1]))
    .filter((value) => Number.isFinite(value));

  if (!amounts.length) {
    return null;
  }

  return Math.max(...amounts);
}

function rankAmountCandidates(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const candidates = [];
  const amountFrequency = new Map();

  for (const line of lines) {
    for (const match of line.matchAll(/(?:\$|MXN)?\s*(-?[0-9]{1,4}(?:[,.][0-9]{3})*(?:[,.]\d{2}))\s*(?:MXN)?/g)) {
      const value = parseCurrency(match[1]);

      if (Number.isFinite(value) && value > 0) {
        amountFrequency.set(value, (amountFrequency.get(value) ?? 0) + 1);
      }
    }
  }

  lines.forEach((line, index) => {
    for (const match of line.matchAll(/(?:\$|MXN)?\s*(-?[0-9]{1,4}(?:[,.][0-9]{3})*(?:[,.]\d{2}))\s*(?:MXN)?/g)) {
      const value = parseCurrency(match[1]);

      if (!Number.isFinite(value) || value <= 0) {
        continue;
      }

      const contextLines = lines.slice(Math.max(0, index - 8), Math.min(lines.length, index + 3));
      const context = contextLines.join(" ");
      const score = scoreAmountCandidate({
        line,
        context,
        index,
        value,
        occurrenceCount: amountFrequency.get(value) ?? 1,
      });

      if (score > 0) {
        candidates.push({
          value,
          score,
          index,
          line,
        });
      }
    }
  });

  return candidates.sort((a, b) => b.score - a.score || b.index - a.index);
}

function scoreAmountCandidate({ line, context, index, value, occurrenceCount = 1 }) {
  let score = 0;
  const normalizedLine = normalizeAmountContext(line);
  const normalizedContext = normalizeAmountContext(context);

  if (/\bSUB\s*TOTAL\b|\bSUBTOTAL\b|\bNETO\b|\bIVA\b|\bIMPUESTO\b|\bAHORRO\b|\bDESCUENTO\b|\bCAMBIO\b/.test(normalizedLine)) {
    score -= 100;
  }

  if (/\bIVA\s*%/.test(normalizedContext) && value <= 30) {
    score -= 100;
  }

  if (/\bSUB\s*TOTAL\b|\bSUBTOTAL\b/.test(normalizedContext)) {
    score -= 25;
  }

  if (/\bGRAN\s+TOTAL\b|\bTOTAL\s+(?:A\s+PAGAR|GENERAL|FINAL)\b/.test(normalizedContext)) {
    score += 95;
  }

  if (/\bTOTAL\b/.test(normalizedLine) && !/\bSUB\s*TOTAL\b|\bSUBTOTAL\b|\bNETO\s+TOTAL\b/.test(normalizedLine)) {
    score += 90;
  }

  if (/\bTOTAL\b/.test(normalizedContext) && !/\bSUB\s*TOTAL\b|\bSUBTOTAL\b/.test(normalizedLine)) {
    score += 55;
  }

  if (/\b(?:TARJETA|EFECTIVO|DEBITO|DEBITO|CREDITO|MASTERCARD|VISA|PAGO)\b/.test(normalizedContext)) {
    score += 45;
  }

  if (occurrenceCount >= 2 && /\b(?:TOTAL|TARJETA|EFECTIVO|DEBITO|CREDITO|VISA|PAGO)\b/.test(normalizedContext)) {
    score += 35 + Math.min(occurrenceCount, 4) * 8;
  }

  if (occurrenceCount === 1 && /\bSUB\s*TOTAL\b|\bSUBTOTAL\b|\bTOTAL\b/.test(normalizedContext)) {
    score -= 12;
  }

  if (/\bMXN\b|\$/.test(normalizedLine)) {
    score += 15;
  }

  if (/\bRECIBIDO\b/.test(normalizedContext)) {
    score += 8;
  }

  if (value < 1) {
    score -= 20;
  }

  score += Math.min(index, 80) / 10;
  return score;
}

function normalizeAmountContext(value) {
  return String(value ?? "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[ \t]+/g, " ");
}

function parseCurrency(value) {
  const text = String(value ?? "").trim();
  const decimalNormalized = /^-?\d{1,9},\d{2}$/.test(text) && !text.includes(".")
    ? text.replace(",", ".")
    : text.replace(/,/g, "");
  const parsed = Number(decimalNormalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractFolio(text) {
  const ticketHash = text.match(/\bTICKET\s*(?:\r?\n|\s)*#\s*([A-Z0-9-]{3,24})\b/i);

  if (ticketHash) {
    return ticketHash[1];
  }

  const oxxoFolio = text.match(
    /(?:FOL[\s_./-]*(?:VTA|UTA)|FO1[\s_./-]*(?:VTA|UTA)|FOLIO[\s_./-]*VTA)[^\nA-Z0-9]*([A-Z0-9-]{4,24})/,
  );

  if (oxxoFolio) {
    return oxxoFolio[1];
  }

  const ticketId = text.match(/\bID\s*[=:]\s*([A-Z0-9-]{6,24})\b/);

  if (ticketId) {
    return ticketId[1];
  }

  const folioLine = text.match(
    /(?:FOLIO|TICKET|TRANS(?:ACCION)?|OPERACION|AUTORIZACION)[^\nA-Z0-9]*([A-Z0-9-]{4,24})/,
  );

  if (folioLine) {
    return folioLine[1];
  }

  return null;
}

function extractCandidates(text, parsed) {
  const ticketHash = findFirst(text, /\bTICKET\s*(?:\r?\n|\s)*#\s*([A-Z0-9-]{3,24})\b/i);
  const longTicketId = parsed.sevenTicket?.ticketId ?? extractLongNumericTicketId(text);
  const ticketId = longTicketId ?? findFirst(text, /\bID\s*[=:]\s*([A-Z0-9-]{6,24})\b/) ?? ticketHash;
  const paymentMethod = extractPaymentMethod(text);
  const folioVenta = findFirst(
    text,
    /(?:FOL[\s_./-]*(?:VTA|UTA)|FO1[\s_./-]*(?:VTA|UTA)|FOLIO[\s_./-]*VTA)[^\nA-Z0-9]*([A-Z0-9-]{4,24})/,
  ) ?? parsed.sevenTicket?.folio ?? ticketHash;

  return {
    rfc: parsed.rfcCandidates,
    folioVenta,
    folioVentaAlternates: buildIdentifierAlternates(folioVenta, { maxChanges: 1, limit: 24 }),
    ticketId,
    ticketIdAlternates: buildIdentifierAlternates(ticketId, { maxChanges: 2, limit: 40 }),
    codigoFacturacion: ticketId,
    fecha: parsed.fecha,
    monto: parsed.monto,
    montoAlternates: rankAmountCandidates(text).map((candidate) => candidate.value).filter(uniqueValue).slice(0, 8),
    ...(paymentMethod
      ? {
          formaPago: paymentMethod.code,
          formaPagoTexto: paymentMethod.label,
        }
      : {}),
  };
}

function uniqueValue(value, index, values) {
  return values.indexOf(value) === index;
}

function extractPaymentMethod(text) {
  const normalized = normalizeAmountContext(text);

  if (/\b(?:EFECTIVO|CASH)\b/.test(normalized)) {
    return { code: "01", label: "Efectivo" };
  }

  if (/\b(?:TRANSFERENCIA|SPEI)\b/.test(normalized)) {
    return { code: "03", label: "Transferencia electronica" };
  }

  if (/\b(?:DEBITO|TARJETA\s+DE\s+DEBITO|VISA\s+DEBIT)\b/.test(normalized)) {
    return { code: "28", label: "Tarjeta de debito" };
  }

  if (/\b(?:CREDITO|VISA\s+CREDITO|MASTERCARD|AMEX|TARJ\.?\s+BANCARIA|TARJETA\s+BANCARIA)\b/.test(normalized)) {
    return { code: "04", label: "Tarjeta de credito" };
  }

  return null;
}

function extractSevenElevenTicketData(text) {
  if (!/\b7\s*ELEVEN\b|\b7-ELEVEN\b|\bSEM980701STA\b/.test(text)) {
    return null;
  }

  const ticketId = extractLongNumericTicketId(text);

  if (!ticketId) {
    return null;
  }

  const compact = ticketId.replace(/\D/g, "");
  const folio = compact.length >= 24 ? compact.slice(18, 24) : null;

  return {
    ticketId: compact,
    folio,
  };
}

function extractLongNumericTicketId(text) {
  const candidates = [...text.matchAll(/\b\d{28,44}\b/g)]
    .map((match) => match[0])
    .filter((value) => !looksLikePhoneOrPrivacyUrl(value));

  return candidates.sort((a, b) => b.length - a.length)[0] ?? null;
}

function looksLikePhoneOrPrivacyUrl(value) {
  return /^01?800/.test(value);
}

function findFirst(text, pattern) {
  return text.match(pattern)?.[1] ?? null;
}

function buildIdentifierAlternates(value, { maxChanges = 1, limit = 16 } = {}) {
  if (!value) {
    return [];
  }

  const compact = value.replace(/[^A-Z0-9]/g, "");
  const alternates = new Set([compact]);
  const confusables = {
    "0": ["O"],
    O: ["0"],
    "1": ["I", "L"],
    I: ["1", "L"],
    L: ["1", "I"],
    "2": ["Z"],
    Z: ["2"],
    "5": ["S"],
    S: ["5"],
    "8": ["B"],
    B: ["8"],
    H: ["M", "N"],
    M: ["H", "N"],
    N: ["M", "H"],
  };

  const queue = [{ value: compact, start: 0, changes: 0 }];

  while (queue.length && alternates.size < limit) {
    const current = queue.shift();

    for (let index = current.start; index < current.value.length; index += 1) {
      const options = confusables[current.value[index]] ?? [];

      for (const option of options) {
        const next = `${current.value.slice(0, index)}${option}${current.value.slice(index + 1)}`;
        if (alternates.has(next)) {
          continue;
        }

        alternates.add(next);

        if (current.changes + 1 < maxChanges && alternates.size < limit) {
          queue.push({
            value: next,
            start: index + 1,
            changes: current.changes + 1,
          });
        }

        if (alternates.size >= limit) {
          break;
        }
      }

      if (alternates.size >= limit) {
        break;
      }
    }
  }

  return [...alternates].slice(0, limit);
}
