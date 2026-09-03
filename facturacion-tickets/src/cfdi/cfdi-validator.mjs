import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";

const maxXmlBytes = 5 * 1024 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rfcPattern = /^[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}$/i;

export class CfdiValidationError extends Error {
  constructor(result) {
    super(`CFDI XML invalido: ${(result?.errors ?? []).join("; ") || "validacion desconocida"}`);
    this.name = "CfdiValidationError";
    this.code = "cfdi_validation_failed";
    this.validationResult = result;
  }
}

export async function validateCfdiDownload({ xmlPath, expected = {}, allowDevelopmentPlaceholder = false }) {
  if (!xmlPath) {
    return buildFailure("xmlPath is required");
  }

  const absoluteXmlPath = resolve(xmlPath);
  const xml = await readFile(absoluteXmlPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });

  if (!xml) {
    return buildFailure(`XML file not found: ${xmlPath}`);
  }

  return validateCfdiXmlText({
    xml,
    expected,
    sourcePath: xmlPath,
    allowDevelopmentPlaceholder,
  });
}

export function validateCfdiXmlText({
  xml,
  expected = {},
  sourcePath = null,
  allowDevelopmentPlaceholder = false,
}) {
  const errors = [];
  const warnings = [];
  const text = Buffer.isBuffer(xml) ? xml.toString("utf8") : String(xml ?? "");
  const byteLength = Buffer.byteLength(text, "utf8");

  if (!text.trim()) {
    return buildFailure("XML is empty", { sourcePath, byteLength });
  }
  if (byteLength > maxXmlBytes) {
    return buildFailure(`XML exceeds ${maxXmlBytes} bytes`, { sourcePath, byteLength });
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
    return buildFailure("DOCTYPE and ENTITY declarations are not allowed", { sourcePath, byteLength });
  }

  const syntax = XMLValidator.validate(text, { allowBooleanAttributes: false });
  if (syntax !== true) {
    return buildFailure(`XML is not well formed: ${syntax?.err?.msg ?? "syntax error"}`, {
      sourcePath,
      byteLength,
    });
  }

  let parsed;
  try {
    parsed = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      removeNSPrefix: true,
      parseAttributeValue: false,
      processEntities: false,
      trimValues: true,
    }).parse(text);
  } catch (error) {
    return buildFailure(`XML could not be parsed: ${error.message}`, { sourcePath, byteLength });
  }

  const placeholder = findNode(parsed, "easysatCfdiPlaceholder");
  if (placeholder) {
    return {
      ok: allowDevelopmentPlaceholder,
      errors: allowDevelopmentPlaceholder ? [] : ["Development CFDI placeholder is not a fiscal XML"],
      warnings: allowDevelopmentPlaceholder ? ["Development fixture placeholder accepted"] : [],
      sourcePath,
      byteLength,
      developmentPlaceholder: true,
      validatedAt: new Date().toISOString(),
      uuid: null,
      rfcEmisor: null,
      rfcReceptor: null,
      total: null,
      fecha: null,
      version: null,
    };
  }

  const comprobante = findNode(parsed, "Comprobante");
  if (!comprobante || typeof comprobante !== "object") {
    errors.push("XML root is not a CFDI Comprobante");
  }

  const emisor = findNode(comprobante, "Emisor") ?? {};
  const receptor = findNode(comprobante, "Receptor") ?? {};
  const timbre = findNode(comprobante, "TimbreFiscalDigital") ?? {};
  const detected = {
    uuid: readAttribute(timbre, "UUID"),
    rfcEmisor: readAttribute(emisor, "Rfc"),
    rfcReceptor: readAttribute(receptor, "Rfc"),
    total: parseNumber(readAttribute(comprobante, "Total")),
    fecha: readAttribute(comprobante, "Fecha"),
    version: readAttribute(comprobante, "Version"),
  };

  if (!detected.uuid) {
    errors.push("UUID is missing");
  } else if (!uuidPattern.test(detected.uuid)) {
    errors.push(`UUID has an invalid format: ${detected.uuid}`);
  }
  validateDetectedRfc("rfcEmisor", detected.rfcEmisor, errors);
  validateDetectedRfc("rfcReceptor", detected.rfcReceptor, errors);
  if (!Number.isFinite(detected.total) || detected.total < 0) {
    errors.push("total is missing or invalid");
  }
  if (!detected.version) {
    warnings.push("CFDI Version is missing");
  }

  compareText({ label: "rfcEmisor", expected: expected.rfcEmisor, actual: detected.rfcEmisor, errors, warnings });
  compareText({ label: "rfcReceptor", expected: expected.rfcReceptor, actual: detected.rfcReceptor, errors, warnings });
  compareMoney({
    label: "total",
    expected: expected.monto ?? expected.total,
    actual: detected.total,
    errors,
    warnings,
  });

  if (expected.fecha && detected.fecha && !String(detected.fecha).startsWith(String(expected.fecha).slice(0, 10))) {
    warnings.push(`fecha differs: expected ${expected.fecha}, actual ${detected.fecha}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    sourcePath,
    byteLength,
    developmentPlaceholder: false,
    validatedAt: new Date().toISOString(),
    ...detected,
  };
}

export function assertValidCfdiXml(options) {
  const result = validateCfdiXmlText(options);
  if (!result.ok) throw new CfdiValidationError(result);
  return result;
}

function findNode(value, targetName) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNode(item, targetName);
      if (found) return found;
    }
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    if (localName(key).toLowerCase() === targetName.toLowerCase()) {
      return Array.isArray(child) ? child[0] ?? null : child;
    }
  }
  for (const child of Object.values(value)) {
    const found = findNode(child, targetName);
    if (found) return found;
  }
  return null;
}

function localName(value) {
  return String(value ?? "").split(":").pop();
}

function readAttribute(node, name) {
  if (!node || typeof node !== "object") return null;
  const match = Object.entries(node).find(([key]) => localName(key).toLowerCase() === name.toLowerCase());
  return match ? String(match[1] ?? "").trim() || null : null;
}

function validateDetectedRfc(label, value, errors) {
  if (!value) {
    errors.push(`${label} is missing`);
  } else if (!rfcPattern.test(value)) {
    errors.push(`${label} has an invalid format: ${value}`);
  }
}

function compareText({ label, expected, actual, errors, warnings }) {
  const expectedText = normalize(expected);
  if (!expectedText) return;
  if (!rfcPattern.test(expectedText)) {
    warnings.push(`${label} expected value was not a complete RFC and was not compared: ${expectedText}`);
    return;
  }
  if (normalize(actual) !== expectedText) {
    errors.push(`${label} differs: expected ${expectedText}, actual ${actual ?? "(missing)"}`);
  }
}

function compareMoney({ label, expected, actual, errors, warnings }) {
  const expectedNumber = parseNumber(expected);
  if (!Number.isFinite(expectedNumber)) return;
  if (!Number.isFinite(actual)) {
    errors.push(`${label} is missing`);
    return;
  }
  const difference = Math.abs(expectedNumber - actual);
  if (difference > 0.01) {
    errors.push(`${label} differs: expected ${expectedNumber.toFixed(2)}, actual ${actual.toFixed(2)}`);
  } else if (difference > 0) {
    warnings.push(`${label} differs by rounding: expected ${expectedNumber}, actual ${actual}`);
  }
}

function parseNumber(value) {
  const text = String(value ?? "").replace(/,/g, "").trim();
  if (!text) return NaN;
  const number = Number(text);
  return Number.isFinite(number) ? number : NaN;
}

function normalize(value) {
  return String(value ?? "").trim().toUpperCase();
}

function buildFailure(error, extra = {}) {
  return {
    ok: false,
    errors: [error],
    warnings: [],
    validatedAt: new Date().toISOString(),
    ...extra,
  };
}
