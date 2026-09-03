import { mkdir, open, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { getPortalKnowledgeStoreMode, getPortalOutcomeMaxAgeDays } from "../config/env.mjs";
import { logger } from "../shared/logger.mjs";
import {
  listSharedPortalOutcomes,
  listSharedTemplateCandidates,
  rememberSharedPortalOutcome,
  shouldReadLocalPortalKnowledge,
  shouldUseSharedPortalKnowledge,
} from "./portal-knowledge-repository.mjs";

const candidatesDir = resolve("data/portal-template-candidates");
const outcomeMemoryDir = resolve("data/portal-outcome-memory");
const outcomeMemoryPath = join(outcomeMemoryDir, "outcomes.json");
const outcomeMemoryLockPath = join(outcomeMemoryDir, "outcomes.lock");
const MANUAL_OUTCOME_REASONS = new Set([
  "captcha_required",
  "login_required",
  "portal_blocked",
  "cloudflare_blocked",
  "bot_protection_detected",
  "portal_access_blocked",
  "access_denied",
  "http_403",
  "forbidden",
]);

export async function findRememberedManualOutcome({ rfcEmisor, portalUrl = null } = {}) {
  const rfc = normalizeRfc(rfcEmisor);

  if (!rfc) {
    return null;
  }

  const targetHost = hostFromUrl(portalUrl);
  const files = shouldReadLocalPortalKnowledge()
    ? await listCandidateFiles(candidatesDir).catch(() => [])
    : [];
  const outcomes = shouldReadLocalPortalKnowledge()
    ? await listStoredOutcomes({ rfc, targetHost })
    : [];

  outcomes.push(...(await listSharedOutcomesSafely({ rfc, targetHost })));

  for (const filePath of files) {
    const document = await readCandidate(filePath);

    if (!document) {
      continue;
    }

    if (document.status === "draft") {
      continue;
    }

    const template = document.template ?? {};
    const candidateRfc = normalizeRfc(template.rfcEmisor ?? document.rfcEmisor);

    if (candidateRfc !== rfc) {
      continue;
    }

    const reason = normalizeManualReason(
      document.reason ??
        document.promotion?.reason ??
        document.compileReport?.stopReason ??
        template.b3Learning?.terminalReason ??
        template.b3Learning?.reason ??
        document.source?.reason,
    );

    if (!reason) {
      continue;
    }

    const candidateUrl = firstString(
      template.portalUrl,
      document.portalUrl,
      document.portalDiscovery?.selectedUrl,
      document.source?.selectedPortalUrl,
    );
    const candidateHost = hostFromUrl(candidateUrl);

    if (targetHost && candidateHost && candidateHost !== targetHost) {
      continue;
    }

    outcomes.push({
      reason,
      statusMessage: statusMessageForReason(reason),
      rfcEmisor: candidateRfc,
      portalUrl: candidateUrl,
      portalHost: candidateHost,
      templateId: template.id ?? null,
      portalFamily: template.portalFamily ?? null,
      sourcePath: filePath.replaceAll("\\", "/"),
      sourceStatus: document.status ?? null,
      createdAt: firstString(document.source?.createdAt, document.createdAt, ""),
    });
  }

  for (const record of await listSharedTemplateCandidatesSafely({ rfcEmisor: rfc })) {
    const candidateOutcome = buildOutcomeFromCandidate(record.candidate, {
      rfc,
      targetHost,
      sourcePath: record.path,
      sourceStatus: record.status,
      createdAt: record.sourceCreatedAt,
    });

    if (candidateOutcome) {
      outcomes.push(candidateOutcome);
    }
  }

  return outcomes
    .filter((outcome) => isOutcomeFresh(outcome.createdAt))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null;
}

export async function rememberPortalOutcome({
  rfcEmisor,
  portalUrl = null,
  reason,
  status = null,
  statusMessage = null,
  source = "orchestrator",
  templateId = null,
  portalFamily = null,
  metadata = null,
} = {}) {
  const rfc = normalizeRfc(rfcEmisor);
  const normalizedReason = normalizeManualReason(reason);

  if (!rfc || !normalizedReason) {
    return null;
  }

  const normalizedInput = {
    rfcEmisor: rfc,
    portalUrl,
    reason: normalizedReason,
    status,
    statusMessage: statusMessage ?? statusMessageForReason(normalizedReason),
    source,
    templateId,
    portalFamily,
    metadata,
  };
  const localEntry = shouldReadLocalPortalKnowledge()
    ? await rememberLocalPortalOutcome(normalizedInput)
    : null;
  const sharedEntry = await rememberSharedOutcomeSafely(normalizedInput);

  return sharedEntry ?? localEntry;
}

export function isRememberableManualOutcome(reason) {
  return Boolean(normalizeManualReason(reason));
}

export function normalizeManualReason(reason) {
  const value = String(reason ?? "").trim();

  if (!value) {
    return null;
  }

  // Exclude placeholder candidate/B3 handoff reasons like "captcha_or_dynamic_flow" from being treated as actual captcha blockages
  if (value === "captcha_or_dynamic_flow") {
    return null;
  }

  if (value.includes("captcha")) {
    return "captcha_required";
  }

  if (value.includes("login")) {
    return "login_required";
  }

  if (MANUAL_OUTCOME_REASONS.has(value)) {
    return value === "cloudflare_blocked" ||
      value === "bot_protection_detected" ||
      value === "portal_access_blocked" ||
      value === "access_denied" ||
      value === "http_403" ||
      value === "forbidden"
      ? "portal_blocked"
      : value;
  }

  return null;
}

async function listStoredOutcomes({ rfc, targetHost }) {
  const memory = await readOutcomeMemory();

  return Object.values(memory)
    .filter((entry) => normalizeRfc(entry?.rfcEmisor) === rfc)
    .filter((entry) => {
      if (!targetHost || !entry?.portalHost) {
        return true;
      }

      return entry.portalHost === targetHost;
    })
    .filter((entry) => normalizeManualReason(entry?.reason))
    .map((entry) => {
      const reason = normalizeManualReason(entry.reason);

      return {
        reason,
        statusMessage: entry.statusMessage ?? statusMessageForReason(reason),
        rfcEmisor: rfc,
        portalUrl: entry.portalUrl ?? null,
        portalHost: entry.portalHost ?? null,
        templateId: entry.templateId ?? null,
        portalFamily: entry.portalFamily ?? null,
        sourcePath: outcomeMemoryPath.replaceAll("\\", "/"),
        sourceStatus: entry.lastStatus ?? null,
        createdAt: entry.lastSeenAt ?? entry.firstSeenAt ?? "",
        failureCount: entry.failureCount ?? 0,
        successCount: entry.successCount ?? 0,
        source: entry.source ?? "outcome_memory",
      };
    });
}

async function rememberLocalPortalOutcome({
  rfcEmisor,
  portalUrl,
  reason,
  status,
  statusMessage,
  source,
  templateId,
  portalFamily,
  metadata,
}) {
  await mkdir(outcomeMemoryDir, { recursive: true });
  const release = await acquireOutcomeMemoryLock();

  try {
    const portalHost = hostFromUrl(portalUrl);
    const now = new Date().toISOString();
    const memory = await readOutcomeMemory();
    const key = buildOutcomeKey({ rfc: rfcEmisor, portalHost, reason });
    const previous = memory[key] ?? {};
    const succeeded = status === "completed" || status === "resolved";
    const entry = {
      ...previous,
      rfcEmisor,
      portalHost,
      portalUrl: portalUrl ?? previous.portalUrl ?? null,
      reason,
      lastStatus: status ?? previous.lastStatus ?? null,
      statusMessage: statusMessage ?? previous.statusMessage ?? statusMessageForReason(reason),
      source,
      templateId: templateId ?? previous.templateId ?? null,
      portalFamily: portalFamily ?? previous.portalFamily ?? null,
      failureCount: succeeded ? previous.failureCount ?? 0 : Number(previous.failureCount ?? 0) + 1,
      successCount: succeeded ? Number(previous.successCount ?? 0) + 1 : previous.successCount ?? 0,
      firstSeenAt: previous.firstSeenAt ?? now,
      lastSeenAt: now,
      metadata: {
        ...(previous.metadata ?? {}),
        ...(metadata ?? {}),
      },
    };

    memory[key] = entry;
    await writeOutcomeMemory(memory);
    return entry;
  } finally {
    await release();
  }
}

async function listSharedOutcomesSafely({ rfc, targetHost }) {
  if (!shouldUseSharedPortalKnowledge()) {
    return [];
  }

  try {
    const entries = await listSharedPortalOutcomes({ rfcEmisor: rfc, portalHost: targetHost });
    return entries
      .filter((entry) => normalizeManualReason(entry.reason))
      .map((entry) => ({
        reason: normalizeManualReason(entry.reason),
        statusMessage: entry.statusMessage ?? statusMessageForReason(entry.reason),
        rfcEmisor: rfc,
        portalUrl: entry.portalUrl ?? null,
        portalHost: entry.portalHost ?? null,
        templateId: entry.templateId ?? null,
        portalFamily: entry.portalFamily ?? null,
        sourcePath: entry.path,
        sourceStatus: entry.lastStatus ?? null,
        createdAt: entry.lastSeenAt ?? entry.firstSeenAt ?? "",
        failureCount: entry.failureCount ?? 0,
        successCount: entry.successCount ?? 0,
        source: entry.source ?? "shared_outcome_memory",
      }));
  } catch (error) {
    handleSharedKnowledgeError("Could not read portal outcomes from shared registry.", error, { rfc });
    return [];
  }
}

async function listSharedTemplateCandidatesSafely(options) {
  if (!shouldUseSharedPortalKnowledge()) {
    return [];
  }

  try {
    return await listSharedTemplateCandidates(options);
  } catch (error) {
    handleSharedKnowledgeError("Could not read manual outcomes from shared templates.", error, options);
    return [];
  }
}

async function rememberSharedOutcomeSafely(input) {
  if (!shouldUseSharedPortalKnowledge()) {
    return null;
  }

  try {
    return await rememberSharedPortalOutcome(input);
  } catch (error) {
    handleSharedKnowledgeError("Could not persist portal outcome in shared registry.", error, {
      rfcEmisor: input.rfcEmisor,
      reason: input.reason,
    });
    return null;
  }
}

function buildOutcomeFromCandidate(document, { rfc, targetHost, sourcePath, sourceStatus, createdAt }) {
  if (!document || document.status === "draft") {
    return null;
  }

  const template = document.template ?? {};
  const candidateRfc = normalizeRfc(template.rfcEmisor ?? document.rfcEmisor);

  if (candidateRfc !== rfc) {
    return null;
  }

  const reason = normalizeManualReason(
    document.reason ??
      document.promotion?.reason ??
      document.compileReport?.stopReason ??
      template.b3Learning?.terminalReason ??
      template.b3Learning?.reason ??
      document.source?.reason,
  );

  if (!reason) {
    return null;
  }

  const candidateUrl = firstString(
    template.portalUrl,
    document.portalUrl,
    document.portalDiscovery?.selectedUrl,
    document.source?.selectedPortalUrl,
  );
  const candidateHost = hostFromUrl(candidateUrl);

  if (targetHost && candidateHost && candidateHost !== targetHost) {
    return null;
  }

  return {
    reason,
    statusMessage: statusMessageForReason(reason),
    rfcEmisor: candidateRfc,
    portalUrl: candidateUrl,
    portalHost: candidateHost,
    templateId: template.id ?? null,
    portalFamily: template.portalFamily ?? null,
    sourcePath,
    sourceStatus: sourceStatus ?? document.status ?? null,
    createdAt: createdAt ?? firstString(document.source?.createdAt, document.createdAt, ""),
  };
}

function handleSharedKnowledgeError(message, error, metadata = {}) {
  if (getPortalKnowledgeStoreMode() === "firestore") {
    throw error;
  }

  logger.warn(message, {
    ...metadata,
    error: error.message,
  });
}

async function acquireOutcomeMemoryLock() {
  const maxWaitMs = 5000;
  const staleAfterMs = 30000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < maxWaitMs) {
    try {
      const handle = await open(outcomeMemoryLockPath, "wx");
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(outcomeMemoryLockPath).catch(() => {});
        throw error;
      }
      return async () => {
        await handle.close().catch(() => {});
        await unlink(outcomeMemoryLockPath).catch(() => {});
      };
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }

      const lockStat = await stat(outcomeMemoryLockPath).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > staleAfterMs) {
        await unlink(outcomeMemoryLockPath).catch(() => {});
        continue;
      }

      await sleep(40);
    }
  }

  throw new Error("Timed out waiting for portal outcome memory lock.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readOutcomeMemory() {
  try {
    return JSON.parse(await readFile(outcomeMemoryPath, "utf8"));
  } catch {
    return {};
  }
}

async function writeOutcomeMemory(memory) {
  await mkdir(outcomeMemoryDir, { recursive: true });
  await writeFile(outcomeMemoryPath, `${JSON.stringify(memory, null, 2)}\n`, "utf8");
}

function buildOutcomeKey({ rfc, portalHost, reason }) {
  return [rfc, portalHost ?? "unknown-host", reason].join("|");
}

async function readCandidate(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function listCandidateFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listCandidateFiles(entryPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".candidate.json") && extname(entry.name) === ".json") {
      files.push(entryPath);
    }
  }

  return files.sort();
}

function statusMessageForReason(reason) {
  if (reason === "captcha_required") {
    return "Este portal ya fue identificado como portal con CAPTCHA. Continúa manualmente desde Capa C.";
  }

  if (reason === "login_required") {
    return "Este portal ya fue identificado como portal que requiere login o cuenta. Continúa manualmente desde Capa C.";
  }

  return "Este portal ya fue identificado como bloqueo manual. Continúa desde Capa C.";
}

function normalizeRfc(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function hostFromUrl(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function isOutcomeFresh(createdAt) {
  if (!createdAt) {
    return true;
  }

  const timestamp = new Date(createdAt).getTime();
  if (!Number.isFinite(timestamp)) {
    return true;
  }

  return Date.now() - timestamp <= getPortalOutcomeMaxAgeDays() * 86400000;
}
