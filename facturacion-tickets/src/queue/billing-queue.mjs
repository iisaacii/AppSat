import { createHash } from "node:crypto";
import { Queue, Worker } from "bullmq";
import {
  getBillingDispatchMode,
  getBillingQueueAttempts,
  getBillingQueueBackoffMs,
  getBillingQueueCompletedRetentionSeconds,
  getBillingQueueFailedRetentionSeconds,
  getBillingQueuePrefix,
  getRedisConnectTimeoutMs,
  getRedisUrl,
} from "../config/env.mjs";
import { normalizeWorkerLane, WORKER_LANES } from "../jobs/job-workflow.mjs";

const queueNames = Object.freeze({
  [WORKER_LANES.OCR]: "billing-ocr",
  [WORKER_LANES.PORTAL]: "billing-portal",
  [WORKER_LANES.CAPA_C]: "billing-capa-c",
});

const producerQueues = new Map();

export function isBillingQueueEnabled() {
  return getBillingDispatchMode() !== "poll";
}

export function getBillingQueueName(lane) {
  const normalizedLane = normalizeQueueLane(lane);
  return queueNames[normalizedLane];
}

export async function dispatchBillingJobSignal({
  uid,
  jobId,
  lane,
  generation = "current",
  delayMs = 0,
  reason = "job_ready",
} = {}) {
  assertIdentity(uid, jobId);
  const normalizedLane = normalizeQueueLane(lane);
  const data = {
    kind: "billing_job",
    uid: clean(uid),
    jobId: clean(jobId),
    lane: normalizedLane,
    generation: clean(generation) || "current",
    reason: clean(reason) || "job_ready",
    dispatchedAt: new Date().toISOString(),
  };
  const queue = getProducerQueue(normalizedLane);
  const job = await queue.add("billing-job", data, {
    ...defaultJobOptions(),
    jobId: buildSignalId("job", data.uid, data.jobId, normalizedLane, data.generation),
    delay: Math.max(0, Math.floor(Number(delayMs) || 0)),
  });

  return summarizeQueueJob(job, normalizedLane);
}

export async function dispatchBillingCommandSignal({ uid, commandId, jobId = null } = {}) {
  if (!clean(uid) || !clean(commandId)) {
    throw new Error("Billing command signal requires uid and commandId.");
  }

  const lane = WORKER_LANES.OCR;
  const data = {
    kind: "billing_command",
    uid: clean(uid),
    commandId: clean(commandId),
    jobId: clean(jobId) || null,
    lane,
    dispatchedAt: new Date().toISOString(),
  };
  const queue = getProducerQueue(lane);
  const job = await queue.add("billing-command", data, {
    ...defaultJobOptions(),
    jobId: buildSignalId("command", data.uid, data.commandId),
  });

  return summarizeQueueJob(job, lane);
}

export function createBillingSignalWorker({ lane, concurrency = 1, processor } = {}) {
  const normalizedLane = normalizeQueueLane(lane);

  if (typeof processor !== "function") {
    throw new Error("Billing signal worker requires a processor function.");
  }

  return new Worker(
    getBillingQueueName(normalizedLane),
    async (job) => processor(job.data, job),
    {
      connection: buildBullMqConnectionOptions({ worker: true }),
      concurrency: Math.max(1, Math.floor(Number(concurrency) || 1)),
      prefix: getBillingQueuePrefix(),
    },
  );
}

export async function inspectBillingQueues() {
  const results = {};

  for (const lane of Object.keys(queueNames)) {
    const queue = getProducerQueue(lane);
    results[lane] = {
      name: getBillingQueueName(lane),
      counts: await queue.getJobCounts("wait", "active", "delayed", "completed", "failed", "paused"),
    };
  }

  return results;
}

export async function inspectBillingQueueTelemetry({
  now = Date.now(),
  failureWindowMs = 900000,
  failedSampleSize = 100,
} = {}) {
  const capturedAtMs = normalizeTimestamp(now, Date.now());
  const normalizedFailureWindowMs = Math.max(60000, Number(failureWindowMs) || 900000);
  const normalizedFailedSampleSize = Math.max(1, Math.min(500, Math.floor(Number(failedSampleSize) || 100)));
  const results = {};
  const firstQueue = getProducerQueue(Object.keys(queueNames)[0]);
  const redisReadyStartedAt = Date.now();
  await firstQueue.waitUntilReady();
  const redisLatencyMs = Math.max(0, Date.now() - redisReadyStartedAt);

  for (const lane of Object.keys(queueNames)) {
    const queue = getProducerQueue(lane);
    const [counts, workersCount, waitingJobs, activeJobs, delayedJobs, failedJobs] = await Promise.all([
      queue.getJobCounts("wait", "active", "delayed", "completed", "failed", "paused"),
      queue.getWorkersCount(),
      getRawQueueJobs(queue, "waiting", 0, 0, true),
      getRawQueueJobs(queue, "active", 0, 0, true),
      getRawQueueJobs(queue, "delayed", 0, 0, true),
      getRawQueueJobs(queue, "failed", 0, normalizedFailedSampleSize - 1, false),
    ]);

    const oldestWaiting = waitingJobs[0] ?? null;
    const oldestActive = activeJobs[0] ?? null;
    const nextDelayed = delayedJobs[0] ?? null;
    const delayedDueAt = nextDelayed
      ? normalizeTimestamp(nextDelayed.timestamp, capturedAtMs) + Math.max(0, Number(nextDelayed.delay) || 0)
      : null;
    const recentFailedJobs = failedJobs.filter((job) => {
      const failedAt = normalizeTimestamp(job.finishedOn ?? job.processedOn ?? job.timestamp, 0);
      return failedAt >= capturedAtMs - normalizedFailureWindowMs;
    });
    const latestFailed = recentFailedJobs[0] ?? failedJobs[0] ?? null;

    results[lane] = {
      name: getBillingQueueName(lane),
      counts: normalizeQueueCounts(counts),
      workersCount: Math.max(0, Math.floor(Number(workersCount) || 0)),
      oldestWaitingAgeMs: ageSince(oldestWaiting?.timestamp, capturedAtMs),
      oldestActiveAgeMs: ageSince(oldestActive?.processedOn ?? oldestActive?.timestamp, capturedAtMs),
      delayedDueInMs: delayedDueAt === null ? null : delayedDueAt - capturedAtMs,
      delayedOverdueMs: delayedDueAt === null ? null : Math.max(0, capturedAtMs - delayedDueAt),
      recentFailures: recentFailedJobs.length,
      latestFailure: latestFailed
        ? {
            id: String(latestFailed.id),
            failedAt: toIso(latestFailed.finishedOn ?? latestFailed.processedOn ?? latestFailed.timestamp),
            reason: truncate(latestFailed.failedReason, 300),
          }
        : null,
    };
  }

  return {
    capturedAt: new Date(capturedAtMs).toISOString(),
    redisLatencyMs,
    failureWindowMs: normalizedFailureWindowMs,
    lanes: results,
  };
}

async function getRawQueueJobs(queue, type, start, end, asc) {
  const backend = typeof queue.getBackend === "function" ? queue.getBackend() : null;
  if (!backend || typeof backend.getJobs !== "function") {
    return getHydratedQueueJobs(queue, type, start, end);
  }

  const groups = await backend.getJobs([type], start, end, asc);
  return toArray(groups?.[0]).map(parseRawQueueJob).filter(Boolean);
}

async function getHydratedQueueJobs(queue, type, start, end) {
  const methods = {
    waiting: "getWaiting",
    active: "getActive",
    delayed: "getDelayed",
    failed: "getFailed",
  };
  const method = methods[type];
  if (!method || typeof queue[method] !== "function") return [];
  return queue[method](start, end);
}

function parseRawQueueJob(entry) {
  if (!Array.isArray(entry) || entry.length < 2) return null;
  const [id, fields] = entry;
  const values = {};
  for (let index = 0; index < toArray(fields).length; index += 2) {
    const key = fields[index];
    if (key !== undefined) values[String(key)] = fields[index + 1];
  }
  return {
    id: String(id),
    timestamp: finiteNumberOrNull(values.timestamp),
    processedOn: finiteNumberOrNull(values.processedOn),
    finishedOn: finiteNumberOrNull(values.finishedOn),
    delay: finiteNumberOrNull(values.delay),
    failedReason: clean(values.failedReason) || null,
  };
}

export async function obliterateBillingQueues() {
  for (const lane of Object.keys(queueNames)) {
    await getProducerQueue(lane).obliterate({ force: true });
  }
}

export async function closeBillingQueueClients() {
  const queues = [...producerQueues.values()];
  producerQueues.clear();
  await Promise.allSettled(queues.map((queue) => queue.close()));
}

export function buildBullMqConnectionOptions({ worker = false } = {}) {
  const url = new URL(getRedisUrl());

  if (!["redis:", "rediss:"].includes(url.protocol)) {
    throw new Error("REDIS_URL must use redis:// or rediss:// for BullMQ.");
  }

  const database = url.pathname && url.pathname !== "/"
    ? Number(url.pathname.slice(1))
    : 0;
  const options = {
    host: url.hostname,
    port: Number(url.port || (url.protocol === "rediss:" ? 6380 : 6379)),
    db: Number.isInteger(database) && database >= 0 ? database : 0,
    connectTimeout: getRedisConnectTimeoutMs(),
    maxRetriesPerRequest: worker ? null : 1,
    enableReadyCheck: true,
  };

  if (url.username) options.username = decodeURIComponent(url.username);
  if (url.password) options.password = decodeURIComponent(url.password);
  if (url.protocol === "rediss:") options.tls = { servername: url.hostname };

  return options;
}

function getProducerQueue(lane) {
  const normalizedLane = normalizeQueueLane(lane);

  if (!producerQueues.has(normalizedLane)) {
    producerQueues.set(
      normalizedLane,
      new Queue(getBillingQueueName(normalizedLane), {
        connection: buildBullMqConnectionOptions(),
        prefix: getBillingQueuePrefix(),
      }),
    );
  }

  return producerQueues.get(normalizedLane);
}

function defaultJobOptions() {
  return {
    attempts: getBillingQueueAttempts(),
    backoff: {
      type: "exponential",
      delay: getBillingQueueBackoffMs(),
    },
    removeOnComplete: {
      age: getBillingQueueCompletedRetentionSeconds(),
      count: 10000,
    },
    removeOnFail: {
      age: getBillingQueueFailedRetentionSeconds(),
      count: 10000,
    },
  };
}

function normalizeQueueLane(lane) {
  const normalizedLane = normalizeWorkerLane(lane);

  if (!queueNames[normalizedLane]) {
    throw new Error(`BullMQ requires a concrete worker lane, received: ${lane}`);
  }

  return normalizedLane;
}

function assertIdentity(uid, jobId) {
  if (!clean(uid) || !clean(jobId)) {
    throw new Error("Billing job signal requires uid and jobId.");
  }
}

function buildSignalId(...parts) {
  const digest = createHash("sha256")
    .update(parts.map((part) => clean(part)).join("|"))
    .digest("hex");
  return `signal-${digest}`;
}

function summarizeQueueJob(job, lane) {
  return {
    id: String(job.id),
    lane,
    name: job.name,
    queueName: getBillingQueueName(lane),
  };
}

function normalizeQueueCounts(counts) {
  return {
    waiting: Number(counts?.wait ?? counts?.waiting ?? 0),
    active: Number(counts?.active ?? 0),
    delayed: Number(counts?.delayed ?? 0),
    completed: Number(counts?.completed ?? 0),
    failed: Number(counts?.failed ?? 0),
    paused: Number(counts?.paused ?? 0),
  };
}

function ageSince(value, now) {
  if (value === undefined || value === null) return null;
  return Math.max(0, now - normalizeTimestamp(value, now));
}

function normalizeTimestamp(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function finiteNumberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toIso(value) {
  const timestamp = normalizeTimestamp(value, 0);
  return timestamp > 0 ? new Date(timestamp).toISOString() : null;
}

function truncate(value, maxLength) {
  const text = clean(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text || null;
}

function clean(value) {
  return String(value ?? "").trim();
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}
