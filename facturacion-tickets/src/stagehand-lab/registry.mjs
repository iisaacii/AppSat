import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getStagehandModel, getStagehandRegistryDir } from "../config/env.mjs";

export const STAGEHAND_PORTAL_STATES = new Set([
  "unknown",
  "learning",
  "candidate_cached",
  "active",
  "degraded",
  "blocked",
]);

export function buildStagehandPortalKey({ rfcEmisor, portalUrl }) {
  const host = getPortalHost(portalUrl);

  return {
    rfcEmisor: normalizeRfc(rfcEmisor),
    portalHost: host,
    key: `${safeFilePart(normalizeRfc(rfcEmisor) || "unknown")}-${safeFilePart(host || "unknown-host")}`,
  };
}

export async function readStagehandPortalState({ rfcEmisor, portalUrl }) {
  const filePath = getStatePath({ rfcEmisor, portalUrl });
  const raw = await readFile(filePath, "utf8").catch((error) => {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  });

  return raw ? JSON.parse(raw) : null;
}

export async function ensureStagehandPortalState({ rfcEmisor, portalUrl, seed = {} }) {
  const existing = await readStagehandPortalState({ rfcEmisor, portalUrl });

  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const key = buildStagehandPortalKey({ rfcEmisor, portalUrl });
  const state = {
    schemaVersion: "stagehand-portal.v1",
    key: key.key,
    rfcEmisor: key.rfcEmisor,
    portalHost: key.portalHost,
    portalUrl,
    status: "unknown",
    version: 1,
    model: getStagehandModel(),
    cacheVersion: null,
    activeFlowId: null,
    successCount: 0,
    failureCount: 0,
    consecutiveSuccesses: 0,
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureReason: null,
    lastError: null,
    evidence: [],
    traces: [],
    selectors: {},
    signals: {},
    cache: {
      actions: [],
    },
    stateHistory: [
      {
        at: now,
        from: null,
        to: "unknown",
        reason: "created",
      },
    ],
    createdAt: now,
    updatedAt: now,
    ...seed,
  };

  await writeStagehandPortalState(state);
  return state;
}

export async function writeStagehandPortalState(state) {
  validateStagehandPortalState(state);
  const filePath = getStatePath(state);
  await mkdir(resolve(getStagehandRegistryDir()), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  return filePath;
}

export async function recordStagehandOutcome({
  rfcEmisor,
  portalUrl,
  mode,
  success,
  reason,
  error = null,
  evidence = [],
  trace = null,
  cache = null,
  selectors = null,
  signals = null,
  cfdiValidationResult = null,
  blockReason = null,
  promotionEligible = true,
}) {
  const previous = await ensureStagehandPortalState({ rfcEmisor, portalUrl });
  const now = new Date().toISOString();
  const next = {
    ...previous,
    model: getStagehandModel(),
    evidence: appendLimited(previous.evidence, evidence, 20),
    traces: appendLimited(previous.traces, trace ? [trace] : [], 20),
    selectors: selectors ? { ...(previous.selectors ?? {}), ...selectors } : (previous.selectors ?? {}),
    signals: signals ? { ...(previous.signals ?? {}), ...signals } : (previous.signals ?? {}),
    cache: cache ?? previous.cache ?? { actions: [] },
    lastError: error,
  };

  const from = previous.status ?? "unknown";
  let to = from;

  if (success) {
    next.successCount = (previous.successCount ?? 0) + 1;
    next.failureCount = previous.failureCount ?? 0;
    next.consecutiveSuccesses = (previous.consecutiveSuccesses ?? 0) + 1;
    next.consecutiveFailures = 0;
    next.lastSuccessAt = now;
    next.lastFailureReason = null;
    next.lastError = null;
    next.cacheVersion = cache?.version ?? previous.cacheVersion ?? now;

    if (!promotionEligible) {
      to = from === "active" ? "active" : "candidate_cached";
    } else if (from === "active") {
      to = "active";
    } else if (from === "candidate_cached" && next.consecutiveSuccesses >= 2) {
      to = "active";
    } else {
      to = "candidate_cached";
    }
  } else {
    next.successCount = previous.successCount ?? 0;
    next.failureCount = (previous.failureCount ?? 0) + 1;
    next.consecutiveSuccesses = 0;
    next.consecutiveFailures = (previous.consecutiveFailures ?? 0) + 1;
    next.lastFailureAt = now;
    next.lastFailureReason = blockReason ?? reason ?? "stagehand_failed";

    if (["captcha_detected", "login_required", "ticket_expired", "fiscal_rule_blocked"].includes(blockReason)) {
      to = "blocked";
    } else if (from === "active" || from === "candidate_cached") {
      to = "degraded";
    } else if (mode === "learn" || mode === "repair") {
      to = "learning";
    }
  }

  next.status = normalizePortalState(to);
  next.stateHistory = appendLimited(
    previous.stateHistory,
    from === next.status
      ? []
      : [
          {
            at: now,
            from,
            to: next.status,
            reason: reason ?? (success ? "stagehand_success" : "stagehand_failed"),
            mode,
          },
        ],
    50,
  );

  if (cfdiValidationResult) {
    next.lastCfdiValidationResult = cfdiValidationResult;
  }

  await writeStagehandPortalState(next);
  return next;
}

export async function listStagehandPortalStates() {
  const dir = resolve(getStagehandRegistryDir());
  const files = await readdir(dir).catch((error) => {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  });
  const states = [];

  for (const file of files.filter((item) => item.endsWith(".json"))) {
    const raw = await readFile(join(dir, file), "utf8").catch(() => null);

    if (!raw) {
      continue;
    }

    const state = JSON.parse(raw);
    validateStagehandPortalState(state);
    states.push(state);
  }

  return states.sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

export function validateStagehandPortalState(state) {
  const errors = [];

  if (state?.schemaVersion !== "stagehand-portal.v1") {
    errors.push("schemaVersion must be stagehand-portal.v1");
  }

  if (!state?.key) {
    errors.push("key is required");
  }

  if (!normalizeRfc(state?.rfcEmisor)) {
    errors.push("rfcEmisor is required");
  }

  if (!state?.portalHost) {
    errors.push("portalHost is required");
  }

  if (!STAGEHAND_PORTAL_STATES.has(state?.status)) {
    errors.push(`invalid status: ${state?.status}`);
  }

  if (!Array.isArray(state?.cache?.actions)) {
    errors.push("cache.actions must be an array");
  }

  if (errors.length) {
    throw new Error(`Invalid Stagehand registry document ${state?.key ?? "(unknown)"}: ${errors.join("; ")}`);
  }

  return true;
}

export function getStagehandStatePathForDisplay({ rfcEmisor, portalUrl }) {
  return getStatePath({ rfcEmisor, portalUrl }).replaceAll("\\", "/");
}

function getStatePath(value) {
  const key = value.key ? value.key : buildStagehandPortalKey(value).key;
  return resolve(getStagehandRegistryDir(), `${key}.json`);
}

function normalizePortalState(status) {
  return STAGEHAND_PORTAL_STATES.has(status) ? status : "unknown";
}

function getPortalHost(url) {
  try {
    return new URL(String(url ?? "")).host.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeRfc(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function appendLimited(previous, next, limit) {
  const existing = Array.isArray(previous) ? previous : [];
  const incoming = Array.isArray(next) ? next.filter(Boolean) : [];
  return [...existing, ...incoming].slice(-limit);
}

function safeFilePart(value) {
  return String(value ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}
