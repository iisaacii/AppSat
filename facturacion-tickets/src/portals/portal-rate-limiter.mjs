import { createHash, randomUUID } from "node:crypto";
import {
  getPortalRateLimitAcquireTimeoutMs,
  getPortalRateLimitBackend,
  getPortalRateLimitLeaseMs,
  getPortalRateLimitNamespace,
  getPortalRateLimitPollMs,
  isPortalRateLimitRedisRequired,
} from "../config/env.mjs";
import { getRedisClient } from "../config/redis.mjs";
import { logger } from "../shared/logger.mjs";

const windowMs = 60000;
const localLimiterState = new Map();

const acquireScript = `
local activeKey = KEYS[1]
local windowKey = KEYS[2]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local concurrency = tonumber(ARGV[3])
local perMinute = tonumber(ARGV[4])
local leaseMs = tonumber(ARGV[5])
local token = ARGV[6]

redis.call('ZREMRANGEBYSCORE', activeKey, '-inf', now)
redis.call('ZREMRANGEBYSCORE', windowKey, '-inf', now - windowMs)

local active = redis.call('ZCARD', activeKey)
local used = redis.call('ZCARD', windowKey)

if active >= concurrency then
  local nextActive = redis.call('ZRANGE', activeKey, 0, 0, 'WITHSCORES')
  local waitMs = 250
  if nextActive[2] then
    waitMs = math.max(50, tonumber(nextActive[2]) - now)
  end
  return {0, waitMs, active, used, 1}
end

if used >= perMinute then
  local oldest = redis.call('ZRANGE', windowKey, 0, 0, 'WITHSCORES')
  local waitMs = 250
  if oldest[2] then
    waitMs = math.max(50, tonumber(oldest[2]) + windowMs - now)
  end
  return {0, waitMs, active, used, 2}
end

redis.call('ZADD', activeKey, now + leaseMs, token)
redis.call('ZADD', windowKey, now, token)
redis.call('PEXPIRE', activeKey, leaseMs + 1000)
redis.call('PEXPIRE', windowKey, windowMs + 1000)

return {1, 0, active + 1, used + 1, 0}
`;

const renewScript = `
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  redis.call('ZADD', KEYS[1], 'XX', tonumber(ARGV[2]), ARGV[1])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) + 1000)
  return 1
end
return 0
`;

const releaseScript = `
return redis.call('ZREM', KEYS[1], ARGV[1])
`;

export async function runWithPortalRateLimit(portal, task, options = {}) {
  const descriptor = buildPortalRateLimitDescriptor(portal);
  let release;

  if (getPortalRateLimitBackend() === "redis") {
    try {
      release = await acquireRedisPortalSlot(descriptor, options);
    } catch (error) {
      if (isPortalRateLimitRedisRequired() || error?.code !== "portal_rate_limit_redis_unavailable") {
        throw error;
      }

      logger.warn("Redis portal limiter unavailable; using process-local fallback.", {
        key: descriptor.key,
        error: error instanceof Error ? error.message : String(error),
      });
      release = await acquireLocalPortalSlot(descriptor, options);
    }
  } else {
    release = await acquireLocalPortalSlot(descriptor, options);
  }

  try {
    return await task();
  } finally {
    await release();
  }
}

export function buildPortalRateLimitDescriptor(portal = {}) {
  const rateLimit = normalizeRateLimit(portal?.rateLimit);
  const portalUrl = firstString(portal?.portalUrl ?? portal?.url);
  const portalHost = hostFromUrl(portalUrl);
  const key =
    firstString(portal?.rateLimitKey) ??
    firstString(portal?.portalFamily) ??
    portalHost ??
    firstString(portal?.rfcEmisor) ??
    firstString(portal?.id) ??
    "unknown-portal";

  return {
    key,
    portalHost,
    concurrency: rateLimit.concurrency,
    perMinute: rateLimit.perMinute,
  };
}

export function resetLocalPortalRateLimiterForTests() {
  localLimiterState.clear();
}

async function acquireRedisPortalSlot(descriptor, options) {
  let client;
  try {
    client = options.redisClient ?? await getRedisClient();
  } catch (error) {
    throw redisUnavailable(error);
  }

  const token = randomUUID();
  const keys = buildRedisKeys(descriptor.key);
  const leaseMs = getPortalRateLimitLeaseMs();
  const timeoutMs = Number(options.timeoutMs ?? getPortalRateLimitAcquireTimeoutMs());
  const startedAt = Date.now();
  let lastWaitLogAt = 0;

  while (true) {
    throwIfAborted(options.signal);
    const now = Date.now();
    let response;

    try {
      response = await client.eval(acquireScript, {
        keys: [keys.active, keys.window],
        arguments: [
          String(now),
          String(windowMs),
          String(descriptor.concurrency),
          String(descriptor.perMinute),
          String(leaseMs),
          token,
        ],
      });
    } catch (error) {
      throw redisUnavailable(error);
    }

    const [acquired, requestedWaitMs, active, perMinuteUsed, waitReason] = toNumberArray(response);

    if (acquired === 1) {
      const heartbeat = startRedisSlotHeartbeat({ client, activeKey: keys.active, token, leaseMs, descriptor });
      let released = false;

      logger.info("Distributed portal rate limit slot acquired.", {
        backend: "redis",
        key: descriptor.key,
        active,
        perMinuteUsed,
        concurrency: descriptor.concurrency,
        perMinute: descriptor.perMinute,
      });

      return async () => {
        if (released) return;
        released = true;
        await heartbeat.stop();
        try {
          await client.eval(releaseScript, {
            keys: [keys.active],
            arguments: [token],
          });
        } catch (error) {
          logger.warn("Could not release Redis portal rate limit slot; lease will expire.", {
            key: descriptor.key,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        logger.info("Distributed portal rate limit slot released.", {
          backend: "redis",
          key: descriptor.key,
        });
      };
    }

    const elapsedMs = now - startedAt;
    if (elapsedMs >= timeoutMs) {
      const error = new Error(`Portal rate limit acquisition timed out for ${descriptor.key}`);
      error.code = "portal_rate_limit_timeout";
      throw error;
    }

    const waitMs = Math.min(
      5000,
      Math.max(getPortalRateLimitPollMs(), requestedWaitMs || getPortalRateLimitPollMs()),
      Math.max(1, timeoutMs - elapsedMs),
    );
    if (now - lastWaitLogAt >= 10000 || lastWaitLogAt === 0) {
      lastWaitLogAt = now;
      logger.info("Distributed portal rate limit waiting.", {
        backend: "redis",
        key: descriptor.key,
        waitMs,
        waitReason: waitReason === 1 ? "concurrency" : "per_minute",
        active,
        perMinuteUsed,
        concurrency: descriptor.concurrency,
        perMinute: descriptor.perMinute,
      });
      await options.onWait?.({ descriptor, waitMs, active, perMinuteUsed, waitReason });
    }
    await sleep(waitMs, options.signal);
  }
}

async function acquireLocalPortalSlot(descriptor, options) {
  const state = getLocalState(descriptor.key);
  const timeoutMs = Number(options.timeoutMs ?? getPortalRateLimitAcquireTimeoutMs());
  const startedAt = Date.now();

  while (true) {
    throwIfAborted(options.signal);
    cleanupLocalState(state);

    const concurrencyOk = state.active < descriptor.concurrency;
    const perMinuteOk = state.timestamps.length < descriptor.perMinute;

    if (concurrencyOk && perMinuteOk) {
      state.active += 1;
      state.timestamps.push(Date.now());
      let released = false;

      logger.info("Portal rate limit slot acquired.", {
        backend: "local",
        key: descriptor.key,
        active: state.active,
        perMinuteUsed: state.timestamps.length,
        concurrency: descriptor.concurrency,
        perMinute: descriptor.perMinute,
      });

      return async () => {
        if (released) return;
        released = true;
        state.active = Math.max(0, state.active - 1);
        logger.info("Portal rate limit slot released.", {
          backend: "local",
          key: descriptor.key,
          active: state.active,
        });
      };
    }

    if (Date.now() - startedAt >= timeoutMs) {
      const error = new Error(`Portal rate limit acquisition timed out for ${descriptor.key}`);
      error.code = "portal_rate_limit_timeout";
      throw error;
    }

    const waitMs = Math.min(
      calculateLocalWaitMs(state, descriptor),
      Math.max(1, timeoutMs - (Date.now() - startedAt)),
    );
    await options.onWait?.({
      descriptor,
      waitMs,
      active: state.active,
      perMinuteUsed: state.timestamps.length,
      waitReason: concurrencyOk ? 2 : 1,
    });
    await sleep(waitMs, options.signal);
  }
}

function startRedisSlotHeartbeat({ client, activeKey, token, leaseMs, descriptor }) {
  const intervalMs = Math.max(1000, Math.floor(leaseMs / 3));
  let stopped = false;
  let inFlight = null;

  const renew = () => {
    if (stopped || inFlight) return;

    inFlight = client.eval(renewScript, {
      keys: [activeKey],
      arguments: [token, String(Date.now() + leaseMs), String(leaseMs)],
    }).then((renewed) => {
      if (Number(renewed) !== 1) {
        logger.warn("Redis portal rate limit lease was lost.", { key: descriptor.key });
      }
    }).catch((error) => {
      logger.warn("Could not renew Redis portal rate limit lease.", {
        key: descriptor.key,
        error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      inFlight = null;
    });
  };

  const timer = setInterval(renew, intervalMs);
  timer.unref?.();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (inFlight) await inFlight;
    },
  };
}

function buildRedisKeys(key) {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 32);
  const namespace = getPortalRateLimitNamespace();
  const hashTag = `{${digest}}`;
  return {
    active: `${namespace}:${hashTag}:active`,
    window: `${namespace}:${hashTag}:window`,
  };
}

function normalizeRateLimit(rateLimit = {}) {
  return {
    concurrency: Math.max(1, Math.floor(Number(rateLimit?.concurrency ?? 1))),
    perMinute: Math.max(1, Math.floor(Number(rateLimit?.perMinute ?? 10))),
  };
}

function getLocalState(key) {
  if (!localLimiterState.has(key)) {
    localLimiterState.set(key, { active: 0, timestamps: [] });
  }
  return localLimiterState.get(key);
}

function cleanupLocalState(state) {
  const cutoff = Date.now() - windowMs;
  state.timestamps = state.timestamps.filter((timestamp) => timestamp > cutoff);
}

function calculateLocalWaitMs(state, descriptor) {
  if (state.active >= descriptor.concurrency) {
    return getPortalRateLimitPollMs();
  }

  if (state.timestamps.length >= descriptor.perMinute) {
    const oldest = Math.min(...state.timestamps);
    return Math.max(getPortalRateLimitPollMs(), oldest + windowMs - Date.now() + 50);
  }

  return getPortalRateLimitPollMs();
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(finish, ms);
    signal?.addEventListener("abort", abort, { once: true });

    function finish() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }

    function abort() {
      clearTimeout(timeout);
      reject(abortReason(signal));
    }
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error("Portal rate limit wait aborted");
}

function redisUnavailable(cause) {
  const error = new Error(`Redis portal rate limiter unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
  error.code = "portal_rate_limit_redis_unavailable";
  error.cause = cause;
  return error;
}

function toNumberArray(value) {
  return Array.isArray(value) ? value.map((item) => Number(item ?? 0)) : [];
}

function hostFromUrl(value) {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

function firstString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
