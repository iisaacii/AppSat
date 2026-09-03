const supportedFormats = new Set([
  "trim",
  "uppercase",
  "lowercase",
  "digits",
  "rfc:uppercase",
  "postalCode:5",
  "taxRegime:code",
  "cfdiUse:code",
  "date:dd/mm/yyyy",
  "date:dd-mm-yyyy",
  "date:yyyy-mm-dd",
  "date:yyyy/mm/dd",
  "date:ddmmyyyy",
  "date:mm/dd/yyyy",
  "number:fixed0",
  "number:fixed2",
  "number:plain",
  "state:mexico-portal",
]);

export function formatValue(value, format) {
  const formats = normalizeFormats(format);
  return formats.reduce((current, item) => applySingleFormat(current, item), value);
}

export function isSupportedValueFormat(format) {
  return normalizeFormats(format).every((item) => supportedFormats.has(item));
}

export function listSupportedValueFormats() {
  return [...supportedFormats].sort();
}

function normalizeFormats(format) {
  if (!format) {
    return [];
  }

  if (Array.isArray(format)) {
    return format.flatMap(normalizeFormats);
  }

  return String(format)
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
}

function applySingleFormat(value, format) {
  if (format === "trim") {
    return String(value ?? "").trim();
  }

  if (format === "uppercase" || format === "rfc:uppercase") {
    return String(value ?? "").trim().toUpperCase();
  }

  if (format === "lowercase") {
    return String(value ?? "").trim().toLowerCase();
  }

  if (format === "digits") {
    return String(value ?? "").replace(/\D+/g, "");
  }

  if (format === "postalCode:5") {
    return String(value ?? "").replace(/\D+/g, "").padStart(5, "0").slice(-5);
  }

  if (format === "taxRegime:code" || format === "cfdiUse:code") {
    return extractLeadingCode(value);
  }

  if (format === "date:dd/mm/yyyy") {
    return formatDate(value, "dd/mm/yyyy");
  }

  if (format === "date:dd-mm-yyyy") {
    return formatDate(value, "dd-mm-yyyy");
  }

  if (format === "date:yyyy-mm-dd") {
    return formatDate(value, "yyyy-mm-dd");
  }

  if (format === "date:yyyy/mm/dd") {
    return formatDate(value, "yyyy/mm/dd");
  }

  if (format === "date:ddmmyyyy") {
    return formatDate(value, "ddmmyyyy");
  }

  if (format === "date:mm/dd/yyyy") {
    return formatDate(value, "mm/dd/yyyy");
  }

  if (format === "number:fixed0") {
    return formatNumberFixed(value, 0);
  }

  if (format === "number:fixed2") {
    return formatNumberFixed(value, 2);
  }

  if (format === "number:plain") {
    return formatNumberPlain(value);
  }

  if (format === "state:mexico-portal") {
    return formatMexicanStateForPortal(value);
  }

  return value;
}

function extractLeadingCode(value) {
  const text = String(value ?? "").trim();
  return text.match(/^[A-Z0-9]+/)?.[0] ?? text;
}

function formatNumberFixed(value, digits) {
  const number = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(number) ? number.toFixed(digits) : value;
}

function formatNumberPlain(value) {
  const number = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(number) ? String(number) : value;
}

function formatDate(value, pattern) {
  const parts = parseDateParts(value);

  if (!parts) {
    return String(value ?? "").trim();
  }

  const { year, month, day } = parts;
  const tokens = {
    yyyy: year,
    mm: month,
    dd: day,
  };

  if (pattern === "ddmmyyyy") {
    return `${day}${month}${year}`;
  }

  return pattern.replace(/yyyy|mm|dd/g, (token) => tokens[token]);
}

function parseDateParts(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return {
      year: String(value.getFullYear()),
      month: String(value.getMonth() + 1).padStart(2, "0"),
      day: String(value.getDate()).padStart(2, "0"),
    };
  }

  const text = String(value ?? "").trim();
  const isoMatch = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);

  if (isoMatch) {
    return {
      year: isoMatch[1],
      month: isoMatch[2].padStart(2, "0"),
      day: isoMatch[3].padStart(2, "0"),
    };
  }

  const dayFirstMatch = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);

  if (dayFirstMatch) {
    return {
      year: dayFirstMatch[3],
      month: dayFirstMatch[2].padStart(2, "0"),
      day: dayFirstMatch[1].padStart(2, "0"),
    };
  }

  return null;
}

function formatMexicanStateForPortal(value) {
  const text = String(value ?? "").trim();
  const normalized = normalizeText(text);
  const aliases = new Map([
    ["MEXICO", "ESTADO DE MEXICO"],
    ["EDO MEX", "ESTADO DE MEXICO"],
    ["EDO. MEX", "ESTADO DE MEXICO"],
    ["ESTADO DE MEXICO", "ESTADO DE MEXICO"],
    ["CDMX", "CIUDAD DE MEXICO"],
    ["DF", "CIUDAD DE MEXICO"],
    ["DISTRITO FEDERAL", "CIUDAD DE MEXICO"],
    ["CIUDAD DE MEXICO", "CIUDAD DE MEXICO"],
  ]);

  return aliases.get(normalized) ?? text;
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}
