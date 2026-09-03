import { getB3UsageThresholds } from "../config/env.mjs";

export function buildB3UsageTelemetry({
  jobId,
  model,
  attempt,
  usage,
  thresholds = getB3UsageThresholds(),
} = {}) {
  if (!usage || typeof usage !== "object") return null;

  const normalized = {
    promptTokens: nonNegative(usage.promptTokens),
    cachedPromptTokens: nonNegative(usage.cachedPromptTokens),
    completionTokens: nonNegative(usage.completionTokens),
    totalTokens: nonNegative(usage.totalTokens),
    entryCount: nonNegative(usage.entryCount),
    estimatedCostUsd: nullableNonNegative(usage.estimatedCostUsd),
    costEstimationRequested: usage.costEstimationRequested === true,
    costCalculated: usage.costCalculated === true,
    pricingSource: String(usage.pricingSource ?? "tokens_only").slice(0, 120),
  };
  const policy = normalizeThresholds(thresholds);
  const cost = normalized.costCalculated ? normalized.estimatedCostUsd : null;
  let severity = "info";

  if (
    normalized.totalTokens >= policy.criticalTokens ||
    (cost !== null && cost >= policy.criticalCostUsd)
  ) {
    severity = "critical";
  } else if (
    normalized.totalTokens >= policy.warningTokens ||
    (cost !== null && cost >= policy.warningCostUsd)
  ) {
    severity = "warning";
  }

  return {
    event: "b3_llm_usage",
    severity,
    jobId: String(jobId ?? "").slice(0, 128) || null,
    model: String(model ?? "unknown").slice(0, 120),
    attempt: Math.max(1, Math.floor(Number(attempt) || 1)),
    ...normalized,
    thresholds: policy,
  };
}

function normalizeThresholds(thresholds = {}) {
  const warningTokens = positive(thresholds.warningTokens, 200000);
  const warningCostUsd = positive(thresholds.warningCostUsd, 0.25);

  return {
    warningTokens,
    criticalTokens: Math.max(warningTokens, positive(thresholds.criticalTokens, 500000)),
    warningCostUsd,
    criticalCostUsd: Math.max(warningCostUsd, positive(thresholds.criticalCostUsd, 1)),
  };
}

function nonNegative(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}

function nullableNonNegative(value) {
  if (value === null || value === undefined || value === "") return null;
  return nonNegative(value);
}

function positive(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}
