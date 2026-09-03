import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const directoryPath = resolve("data/portal-url-directory.json");
const hashmapDirectoryPath = resolve("data/portal-url-directory-hashmap.json");

export async function findPortalCandidatesByRfc(rfcEmisor) {
  const normalizedRfc = normalizeRfc(rfcEmisor);

  if (!normalizedRfc) {
    return [];
  }

  const entries = await loadPortalUrlDirectory();

  return entries
    .filter((entry) => normalizeRfc(entry.rfcEmisor) === normalizedRfc)
    .map((entry) => ({
      url: entry.url,
      name: entry.name ?? null,
      source: entry.source ?? "portal_url_directory",
      confidence: normalizeConfidence(entry.confidence),
      rfcEmisor: normalizedRfc,
      notes: entry.notes ?? null,
    }))
    .filter((entry) => isAllowedPortalUrl(entry.url))
    .sort((a, b) => b.confidence - a.confidence);
}

export async function loadPortalUrlDirectory() {
  const entries = await loadArrayDirectory();
  const hashmapEntries = await loadHashmapDirectory();

  return dedupeDirectoryEntries([...entries, ...hashmapEntries]);
}

export async function loadPortalUrlDirectoryHashmap() {
  const raw = await readFile(hashmapDirectoryPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") {
      return "{}";
    }

    throw error;
  });
  const parsed = JSON.parse(raw);

  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("data/portal-url-directory-hashmap.json must contain an object keyed by RFC");
  }

  return parsed;
}

export function normalizePortalUrlHashmapEntries(hashmap) {
  return Object.entries(hashmap ?? {})
    .map(([key, value]) => {
      const rfc = normalizeRfc(key);

      if (!isValidRfc(rfc)) {
        return null;
      }

      return {
        rfcEmisor: rfc,
        name: clean(value?.nombreComercial) || clean(value?.razonSocial) || null,
        legalName: clean(value?.razonSocial) || null,
        url: clean(value?.portalFacturacionUrl),
        source: "portal_url_directory_hashmap",
        confidence: 0.94,
        notes: clean(value?.notas) || null,
      };
    })
    .filter((entry) => entry && isAllowedPortalUrl(entry.url));
}

export function validatePortalUrlDirectoryHashmap(hashmap) {
  const errors = [];
  const warnings = [];

  if (!hashmap || Array.isArray(hashmap) || typeof hashmap !== "object") {
    return {
      ok: false,
      errors: ["hashmap must be an object keyed by RFC"],
      warnings,
    };
  }

  Object.entries(hashmap).forEach(([key, value]) => {
    const prefix = `entries.${key}`;
    const rfc = normalizeRfc(key);

    if (!isValidRfc(rfc)) {
      warnings.push(`${prefix} is not a valid RFC key; it will be ignored by RFC lookup`);
    }

    if (!isAllowedPortalUrl(value?.portalFacturacionUrl)) {
      errors.push(`${prefix}.portalFacturacionUrl must be http:// or https://`);
    }
  });

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

async function loadArrayDirectory() {
  const raw = await readFile(directoryPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") {
      return "[]";
    }

    throw error;
  });
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error("data/portal-url-directory.json must contain an array");
  }

  return parsed;
}

async function loadHashmapDirectory() {
  const hashmap = await loadPortalUrlDirectoryHashmap();

  return normalizePortalUrlHashmapEntries(hashmap);
}

export function validatePortalUrlDirectory(entries) {
  const errors = [];
  const warnings = [];
  const seen = new Set();

  if (!Array.isArray(entries)) {
    return {
      ok: false,
      errors: ["directory must be an array"],
      warnings,
    };
  }

  entries.forEach((entry, index) => {
    const prefix = `entries[${index}]`;
    const rfc = normalizeRfc(entry?.rfcEmisor);
    const url = String(entry?.url ?? "").trim();
    const confidence = Number(entry?.confidence);
    const signature = `${rfc} ${url}`;

    if (!/^[A-Z&]{3,4}\d{6}[A-Z0-9]{3}$/.test(rfc)) {
      errors.push(`${prefix}.rfcEmisor invalid`);
    }

    if (!isAllowedPortalUrl(url)) {
      errors.push(`${prefix}.url must be http://, https:// or file://`);
    }

    if (entry?.confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
      errors.push(`${prefix}.confidence must be between 0 and 1`);
    }

    if (seen.has(signature)) {
      warnings.push(`${prefix} duplicates RFC/url pair`);
    }

    seen.add(signature);
  });

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

function normalizeRfc(value) {
  return String(value ?? "").trim().toUpperCase();
}

function isValidRfc(value) {
  return /^[A-Z&]{3,4}\d{6}[A-Z0-9]{3}$/.test(normalizeRfc(value));
}

function normalizeConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0.5;
}

function isAllowedPortalUrl(value) {
  return /^(https?|file):\/\//i.test(String(value ?? "").trim());
}

function dedupeDirectoryEntries(entries) {
  const bySignature = new Map();

  for (const entry of entries) {
    const rfc = normalizeRfc(entry?.rfcEmisor);
    const url = clean(entry?.url);

    if (!rfc || !url) {
      continue;
    }

    const signature = `${rfc} ${url}`;
    const normalized = {
      ...entry,
      rfcEmisor: rfc,
      url,
      confidence: normalizeConfidence(entry?.confidence),
    };
    const previous = bySignature.get(signature);

    if (!previous || normalized.confidence > previous.confidence) {
      bySignature.set(signature, normalized);
    }
  }

  return [...bySignature.values()];
}

function clean(value) {
  return String(value ?? "").trim();
}
