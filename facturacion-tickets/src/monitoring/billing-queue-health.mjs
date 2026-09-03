import { getBillingQueueHealthThresholds } from "../config/env.mjs";

const severityRank = Object.freeze({
  healthy: 0,
  warning: 1,
  critical: 2,
});

export function evaluateBillingQueueHealth(
  telemetry,
  {
    requireWorkers = false,
    suppressMissingWorkers = false,
    thresholds = getBillingQueueHealthThresholds(),
  } = {},
) {
  const policy = normalizeThresholds(thresholds);
  const lanes = {};
  const allAlerts = [];

  for (const [lane, snapshot] of Object.entries(telemetry?.lanes ?? {})) {
    const alerts = evaluateLane(lane, snapshot, {
      requireWorkers,
      suppressMissingWorkers,
      thresholds: policy,
    });
    const status = highestSeverity(alerts);
    lanes[lane] = {
      ...snapshot,
      status,
      alerts,
    };
    allAlerts.push(...alerts);
  }

  if (Object.keys(lanes).length === 0) {
    allAlerts.push(buildAlert({
      severity: "critical",
      code: "queue_snapshot_empty",
      message: "No se obtuvo telemetria de ninguna cola de facturacion.",
    }));
  }

  const status = highestSeverity(allAlerts);
  return {
    status,
    healthy: status === "healthy",
    capturedAt: telemetry?.capturedAt ?? new Date().toISOString(),
    redisLatencyMs: numericOrNull(telemetry?.redisLatencyMs),
    failureWindowMs: numericOrNull(telemetry?.failureWindowMs) ?? policy.failureWindowMs,
    requireWorkers: Boolean(requireWorkers),
    suppressMissingWorkers: Boolean(suppressMissingWorkers),
    thresholds: policy,
    totals: summarizeLanes(lanes),
    alerts: allAlerts,
    lanes,
  };
}

export function buildQueueHealthFailure(error, { capturedAt = new Date().toISOString() } = {}) {
  const message = String(error?.message ?? error ?? "Unknown queue health error").slice(0, 500);
  const alert = buildAlert({
    severity: "critical",
    code: "queue_backend_unavailable",
    message: "No se pudo consultar Redis/BullMQ.",
    details: message,
  });

  return {
    status: "critical",
    healthy: false,
    capturedAt,
    redisLatencyMs: null,
    totals: emptyTotals(),
    alerts: [alert],
    lanes: {},
  };
}

export function getQueueHealthFingerprint(health) {
  return (health?.alerts ?? [])
    .map((alert) => `${alert.severity}:${alert.lane ?? "all"}:${alert.code}`)
    .sort()
    .join("|") || "healthy";
}

function evaluateLane(lane, snapshot = {}, { requireWorkers, suppressMissingWorkers, thresholds }) {
  const counts = normalizeCounts(snapshot.counts);
  const workersCount = Math.max(0, Math.floor(Number(snapshot.workersCount) || 0));
  const alerts = [];
  const pendingWork = counts.waiting + counts.active + (Number(snapshot.delayedOverdueMs) > 0 ? 1 : 0);

  if (counts.paused > 0) {
    alerts.push(buildAlert({
      lane,
      severity: "critical",
      code: "queue_paused",
      message: "La cola esta pausada.",
      observed: counts.paused,
      threshold: 0,
    }));
  }

  if (!suppressMissingWorkers && workersCount === 0 && (requireWorkers || pendingWork > 0)) {
    alerts.push(buildAlert({
      lane,
      severity: "critical",
      code: "worker_missing",
      message: requireWorkers
        ? "No hay workers conectados para esta cola."
        : "Hay trabajo pendiente pero ningun worker conectado.",
      observed: workersCount,
      threshold: 1,
    }));
  }

  pushThresholdAlert(alerts, {
    lane,
    value: counts.waiting,
    warning: thresholds.warningWaiting,
    critical: thresholds.criticalWaiting,
    warningCode: "queue_backlog_warning",
    criticalCode: "queue_backlog_critical",
    message: "La cantidad de trabajos en espera supero el umbral.",
  });

  pushThresholdAlert(alerts, {
    lane,
    value: snapshot.oldestWaitingAgeMs,
    warning: thresholds.warningOldestMs,
    critical: thresholds.criticalOldestMs,
    warningCode: "oldest_waiting_warning",
    criticalCode: "oldest_waiting_critical",
    message: "El trabajo mas antiguo lleva demasiado tiempo esperando.",
  });

  pushThresholdAlert(alerts, {
    lane,
    value: snapshot.oldestActiveAgeMs,
    warning: thresholds.warningActiveMs,
    critical: thresholds.criticalActiveMs,
    warningCode: "active_job_slow",
    criticalCode: "active_job_stalled",
    message: "Un trabajo activo excedio el tiempo operativo esperado.",
  });

  pushThresholdAlert(alerts, {
    lane,
    value: snapshot.delayedOverdueMs,
    warning: thresholds.warningDelayedOverdueMs,
    critical: thresholds.criticalDelayedOverdueMs,
    warningCode: "delayed_job_overdue",
    criticalCode: "delayed_job_stalled",
    message: "Un reintento diferido ya debio regresar a procesamiento.",
  });

  pushThresholdAlert(alerts, {
    lane,
    value: snapshot.recentFailures,
    warning: thresholds.warningFailures,
    critical: thresholds.criticalFailures,
    warningCode: "recent_failures_warning",
    criticalCode: "recent_failures_critical",
    message: "Se acumularon fallos recientes en la cola.",
    details: snapshot.latestFailure?.reason ?? null,
  });

  return alerts;
}

function pushThresholdAlert(alerts, {
  lane,
  value,
  warning,
  critical,
  warningCode,
  criticalCode,
  message,
  details = null,
}) {
  const observed = numericOrNull(value);
  if (observed === null) return;

  if (observed >= critical) {
    alerts.push(buildAlert({
      lane,
      severity: "critical",
      code: criticalCode,
      message,
      observed,
      threshold: critical,
      details,
    }));
  } else if (observed >= warning) {
    alerts.push(buildAlert({
      lane,
      severity: "warning",
      code: warningCode,
      message,
      observed,
      threshold: warning,
      details,
    }));
  }
}

function buildAlert({ lane = null, severity, code, message, observed = null, threshold = null, details = null }) {
  return {
    severity,
    code,
    ...(lane ? { lane } : {}),
    message,
    ...(observed !== null ? { observed } : {}),
    ...(threshold !== null ? { threshold } : {}),
    ...(details ? { details: String(details).slice(0, 500) } : {}),
  };
}

function highestSeverity(alerts) {
  let status = "healthy";

  for (const alert of alerts) {
    if ((severityRank[alert.severity] ?? 0) > severityRank[status]) {
      status = alert.severity;
    }
  }

  return status;
}

function normalizeThresholds(thresholds = {}) {
  const warningWaiting = positive(thresholds.warningWaiting, 25);
  const warningOldestMs = positive(thresholds.warningOldestMs, 120000);
  const warningActiveMs = positive(thresholds.warningActiveMs, 1200000);
  const warningDelayedOverdueMs = positive(thresholds.warningDelayedOverdueMs, 60000);
  const warningFailures = positive(thresholds.warningFailures, 3);

  return {
    warningWaiting,
    criticalWaiting: Math.max(warningWaiting, positive(thresholds.criticalWaiting, 100)),
    warningOldestMs,
    criticalOldestMs: Math.max(warningOldestMs, positive(thresholds.criticalOldestMs, 600000)),
    warningActiveMs,
    criticalActiveMs: Math.max(warningActiveMs, positive(thresholds.criticalActiveMs, 2700000)),
    warningDelayedOverdueMs,
    criticalDelayedOverdueMs: Math.max(
      warningDelayedOverdueMs,
      positive(thresholds.criticalDelayedOverdueMs, 300000),
    ),
    failureWindowMs: positive(thresholds.failureWindowMs, 900000),
    warningFailures,
    criticalFailures: Math.max(warningFailures, positive(thresholds.criticalFailures, 10)),
  };
}

function summarizeLanes(lanes) {
  return Object.values(lanes).reduce((totals, lane) => {
    totals.workers += Number(lane.workersCount) || 0;
    totals.waiting += Number(lane.counts?.waiting) || 0;
    totals.active += Number(lane.counts?.active) || 0;
    totals.delayed += Number(lane.counts?.delayed) || 0;
    totals.completed += Number(lane.counts?.completed) || 0;
    totals.failed += Number(lane.counts?.failed) || 0;
    totals.recentFailures += Number(lane.recentFailures) || 0;
    return totals;
  }, emptyTotals());
}

function emptyTotals() {
  return {
    workers: 0,
    waiting: 0,
    active: 0,
    delayed: 0,
    completed: 0,
    failed: 0,
    recentFailures: 0,
  };
}

function normalizeCounts(counts = {}) {
  return {
    waiting: Math.max(0, Number(counts.waiting ?? counts.wait) || 0),
    active: Math.max(0, Number(counts.active) || 0),
    delayed: Math.max(0, Number(counts.delayed) || 0),
    completed: Math.max(0, Number(counts.completed) || 0),
    failed: Math.max(0, Number(counts.failed) || 0),
    paused: Math.max(0, Number(counts.paused) || 0),
  };
}

function positive(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function numericOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
