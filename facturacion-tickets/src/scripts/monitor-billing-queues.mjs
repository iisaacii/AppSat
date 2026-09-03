import {
  getBillingMonitorAlertCooldownMs,
  getBillingMonitorIntervalMs,
  getBillingMonitorStartupGraceMs,
  getBillingQueueHealthThresholds,
  shouldBillingMonitorRequireWorkers,
} from "../config/env.mjs";
import {
  buildQueueHealthFailure,
  evaluateBillingQueueHealth,
  getQueueHealthFingerprint,
} from "../monitoring/billing-queue-health.mjs";
import {
  closeBillingQueueClients,
  inspectBillingQueueTelemetry,
} from "../queue/billing-queue.mjs";
import { logger } from "../shared/logger.mjs";

const watch = process.argv.includes("--watch");
const strict = process.argv.includes("--strict");
const intervalMs = getBillingMonitorIntervalMs();
const startupGraceMs = getBillingMonitorStartupGraceMs();
const alertCooldownMs = getBillingMonitorAlertCooldownMs();
const thresholds = getBillingQueueHealthThresholds();
const configuredRequireWorkers = shouldBillingMonitorRequireWorkers();
const startedAt = Date.now();

let stopped = false;
let lastFingerprint = null;
let lastAlertAt = 0;
let lastStatus = null;
let iteration = 0;
let interruptSleep = null;

if (watch) {
  registerShutdownHandlers();
  logger.info("Billing queue monitor started.", {
    event: "billing_queue_monitor_started",
    intervalMs,
    startupGraceMs,
    alertCooldownMs,
    requireWorkers: configuredRequireWorkers,
  });
  await runWatchLoop();
} else {
  const health = await captureHealth();
  console.log(JSON.stringify(health, null, 2));
  if (strict) process.exitCode = exitCodeForStatus(health.status);
}

await closeBillingQueueClients();

async function runWatchLoop() {
  while (!stopped) {
    const health = await captureHealth();
    emitHealth(health);
    iteration += 1;
    if (!stopped) await sleep(intervalMs);
  }

  logger.info("Billing queue monitor stopped.", {
    event: "billing_queue_monitor_stopped",
  });
}

async function captureHealth() {
  try {
    const telemetry = await inspectBillingQueueTelemetry({
      failureWindowMs: thresholds.failureWindowMs,
    });
    const graceElapsed = !watch || Date.now() - startedAt >= startupGraceMs;
    return evaluateBillingQueueHealth(telemetry, {
      requireWorkers: configuredRequireWorkers && graceElapsed,
      suppressMissingWorkers: watch && !graceElapsed,
      thresholds,
    });
  } catch (error) {
    return buildQueueHealthFailure(error);
  }
}

function emitHealth(health) {
  const fingerprint = getQueueHealthFingerprint(health);
  const now = Date.now();
  const changed = fingerprint !== lastFingerprint;
  const cooldownElapsed = now - lastAlertAt >= alertCooldownMs;
  const recovered = health.status === "healthy" && lastStatus && lastStatus !== "healthy";
  const heartbeatDue = iteration % 10 === 0;
  const meta = {
    event: health.status === "healthy" ? "billing_queue_health" : "billing_queue_alert",
    status: health.status,
    capturedAt: health.capturedAt,
    redisLatencyMs: health.redisLatencyMs,
    totals: health.totals,
    alerts: health.alerts,
  };

  if (recovered) {
    logger.info("Billing queues recovered.", { ...meta, event: "billing_queue_recovered" });
  } else if (health.status === "critical" && (changed || cooldownElapsed)) {
    logger.error("Billing queue health is critical.", meta);
    lastAlertAt = now;
  } else if (health.status === "warning" && (changed || cooldownElapsed)) {
    logger.warn("Billing queue health warning.", meta);
    lastAlertAt = now;
  } else if (health.status === "healthy" && (changed || heartbeatDue)) {
    logger.info("Billing queues healthy.", meta);
  }

  lastFingerprint = fingerprint;
  lastStatus = health.status;
}

function registerShutdownHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      stopped = true;
      interruptSleep?.();
      logger.info("Billing queue monitor shutdown requested.", { signal });
    });
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      interruptSleep = null;
      resolve();
    }, ms);
    interruptSleep = () => {
      clearTimeout(timer);
      interruptSleep = null;
      resolve();
    };
  });
}

function exitCodeForStatus(status) {
  if (status === "critical") return 2;
  if (status === "warning") return 1;
  return 0;
}
