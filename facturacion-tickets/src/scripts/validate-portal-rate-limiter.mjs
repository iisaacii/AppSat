import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildPortalRateLimitDescriptor,
  resetLocalPortalRateLimiterForTests,
  runWithPortalRateLimit,
} from "../portals/portal-rate-limiter.mjs";

const redisMode = process.argv.includes("--redis");

if (redisMode) {
  await validateRedisAcrossProcesses();
} else {
  await validateLocalLimiter();
}

async function validateLocalLimiter() {
  process.env.PORTAL_RATE_LIMIT_BACKEND = "local";
  process.env.PORTAL_RATE_LIMIT_POLL_MS = "50";
  resetLocalPortalRateLimiterForTests();

  assert.deepEqual(
    buildPortalRateLimitDescriptor({
      portalUrl: "https://www.example.com/facturacion",
      rateLimit: { concurrency: 2, perMinute: 7 },
    }),
    {
      key: "example.com",
      portalHost: "example.com",
      concurrency: 2,
      perMinute: 7,
    },
  );

  let active = 0;
  let maxActive = 0;
  const order = [];
  const portal = {
    rateLimitKey: "local-serial-test",
    rateLimit: { concurrency: 1, perMinute: 100 },
  };
  const task = (id, holdMs) => runWithPortalRateLimit(portal, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(`${id}:start`);
    await delay(holdMs);
    order.push(`${id}:end`);
    active -= 1;
  }, { timeoutMs: 2000 });

  await Promise.all([task("a", 120), task("b", 10)]);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);

  let releaseFirst;
  let firstStarted;
  const firstStartedPromise = new Promise((resolve) => { firstStarted = resolve; });
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = runWithPortalRateLimit(portal, async () => {
    firstStarted();
    await gate;
  }, { timeoutMs: 2000 });
  await firstStartedPromise;

  const abort = new AbortController();
  const waiting = runWithPortalRateLimit(portal, async () => {}, {
    timeoutMs: 2000,
    signal: abort.signal,
  });
  abort.abort(new Error("test-abort"));
  await assert.rejects(waiting, /test-abort/);
  releaseFirst();
  await first;

  const unavailableRedis = {
    async eval() {
      throw new Error("redis-test-unavailable");
    },
  };
  process.env.PORTAL_RATE_LIMIT_BACKEND = "redis";
  process.env.PORTAL_RATE_LIMIT_REDIS_REQUIRED = "false";
  let fallbackRan = false;
  await runWithPortalRateLimit({
    rateLimitKey: "redis-fallback-test",
    rateLimit: { concurrency: 1, perMinute: 100 },
  }, async () => {
    fallbackRan = true;
  }, { redisClient: unavailableRedis, timeoutMs: 1000 });
  assert.equal(fallbackRan, true);

  process.env.PORTAL_RATE_LIMIT_REDIS_REQUIRED = "true";
  await assert.rejects(
    runWithPortalRateLimit({
      rateLimitKey: "redis-required-test",
      rateLimit: { concurrency: 1, perMinute: 100 },
    }, async () => {}, { redisClient: unavailableRedis, timeoutMs: 1000 }),
    (error) => error?.code === "portal_rate_limit_redis_unavailable",
  );
  process.env.PORTAL_RATE_LIMIT_BACKEND = "local";
  process.env.PORTAL_RATE_LIMIT_REDIS_REQUIRED = "false";

  console.log(JSON.stringify({
    ok: true,
    backend: "local",
    serializesSamePortal: true,
    abortableWait: true,
    redisFallback: true,
    redisRequiredFailsClosed: true,
  }, null, 2));
}

async function validateRedisAcrossProcesses() {
  const namespace = `appsat:test:portal:${Date.now()}:${process.pid}`;
  const env = {
    ...process.env,
    PORTAL_RATE_LIMIT_BACKEND: "redis",
    PORTAL_RATE_LIMIT_REDIS_REQUIRED: "true",
    PORTAL_RATE_LIMIT_NAMESPACE: namespace,
    PORTAL_RATE_LIMIT_POLL_MS: "50",
    PORTAL_RATE_LIMIT_ACQUIRE_TIMEOUT_MS: "10000",
  };
  const first = spawnProbe({ id: "first", key: "shared-portal", holdMs: 500, env });
  const firstAcquired = await first.acquired;
  const second = spawnProbe({ id: "second", key: "shared-portal", holdMs: 20, env });
  const [firstResult, secondResult] = await Promise.all([first.done, second.done]);

  assert.equal(firstResult.id, "first");
  assert.equal(secondResult.id, "second");
  assert.ok(firstAcquired.acquiredAt <= firstResult.releasedAt);
  assert.ok(
    secondResult.acquiredAt >= firstResult.releasedAt - 20,
    `Second process acquired too early: ${JSON.stringify({ firstResult, secondResult })}`,
  );

  console.log(JSON.stringify({
    ok: true,
    backend: "redis",
    namespace,
    separateProcesses: true,
    first: firstResult,
    second: secondResult,
  }, null, 2));
}

function spawnProbe({ id, key, holdMs, env }) {
  const childPath = fileURLToPath(new URL("./portal-rate-limit-probe-child.mjs", import.meta.url));
  const child = spawn(process.execPath, [
    childPath,
    `--id=${id}`,
    `--key=${key}`,
    `--hold-ms=${holdMs}`,
    "--timeout-ms=10000",
  ], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let acquiredResolve;
  let acquiredReject;
  const acquired = new Promise((resolve, reject) => {
    acquiredResolve = resolve;
    acquiredReject = reject;
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    const match = stdout.match(/PROBE_ACQUIRED (\{[^\r\n]+\})/);
    if (match) acquiredResolve(JSON.parse(match[1]));
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const done = new Promise((resolve, reject) => {
    child.on("error", (error) => {
      acquiredReject(error);
      reject(error);
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        const error = new Error(`Probe ${id} failed with ${code}: ${stderr || stdout}`);
        acquiredReject(error);
        reject(error);
        return;
      }
      const match = stdout.match(/PROBE_RESULT (\{[^\r\n]+\})/);
      if (!match) {
        reject(new Error(`Probe ${id} did not return a result: ${stdout}`));
        return;
      }
      resolve(JSON.parse(match[1]));
    });
  });

  return { acquired, done };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
