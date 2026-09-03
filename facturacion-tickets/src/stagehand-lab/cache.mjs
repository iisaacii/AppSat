import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getStagehandCacheDir } from "../config/env.mjs";
import { buildStagehandPortalKey } from "./registry.mjs";

export const STAGEHAND_CACHE_STEP_TYPES = new Set([
  "goto",
  "fill",
  "fillFirstVisible",
  "select",
  "check",
  "click",
  "clickFirstVisible",
  "clickText",
  "act",
  "observe",
  "finalSubmit",
  "download",
  "waitForSelector",
  "waitForEnabled",
  "waitForText",
]);

export async function readStagehandCache({ rfcEmisor, portalUrl }) {
  const filePath = getCachePath({ rfcEmisor, portalUrl });
  const raw = await readFile(filePath, "utf8").catch((error) => {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  });

  return raw ? JSON.parse(raw) : null;
}

export async function writeStagehandCache({ rfcEmisor, portalUrl, actions, metadata = {} }) {
  const key = buildStagehandPortalKey({ rfcEmisor, portalUrl });
  const cache = {
    schemaVersion: "stagehand-cache.v1",
    key: key.key,
    rfcEmisor: key.rfcEmisor,
    portalHost: key.portalHost,
    portalUrl,
    version: new Date().toISOString(),
    actions: normalizeActions(actions),
    metadata,
  };

  validateStagehandCache(cache);
  await mkdir(resolve(getStagehandCacheDir()), { recursive: true });
  await writeFile(getCachePath(cache), `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  return cache;
}

export function validateStagehandCache(cache) {
  const errors = [];

  if (cache?.schemaVersion !== "stagehand-cache.v1") {
    errors.push("schemaVersion must be stagehand-cache.v1");
  }

  if (!cache?.key) {
    errors.push("key is required");
  }

  if (!Array.isArray(cache?.actions)) {
    errors.push("actions must be an array");
  }

  for (const [index, action] of (cache?.actions ?? []).entries()) {
    if (!STAGEHAND_CACHE_STEP_TYPES.has(action?.type)) {
      errors.push(`actions[${index}].type is invalid: ${action?.type}`);
    }

    if (
      action?.type !== "goto" &&
      action?.type !== "act" &&
      action?.type !== "download" &&
      !action?.selector &&
      !action?.text &&
      !action?.instruction
    ) {
      errors.push(`actions[${index}] requires selector, text or instruction`);
    }

    if (action?.type === "download" && !action?.xmlSelector && !action?.pdfSelector) {
      errors.push(`actions[${index}] download requires xmlSelector or pdfSelector`);
    }
  }

  if (errors.length) {
    throw new Error(`Invalid Stagehand cache ${cache?.key ?? "(unknown)"}: ${errors.join("; ")}`);
  }

  return true;
}

export function getStagehandCachePathForDisplay({ rfcEmisor, portalUrl }) {
  return getCachePath({ rfcEmisor, portalUrl }).replaceAll("\\", "/");
}

function normalizeActions(actions) {
  return (Array.isArray(actions) ? actions : []).map((action, index) => ({
    id: action.id ?? `step_${String(index + 1).padStart(2, "0")}`,
    ...action,
  }));
}

function getCachePath(value) {
  const key = value.key ? value.key : buildStagehandPortalKey(value).key;
  return resolve(getStagehandCacheDir(), `${key}.json`);
}
