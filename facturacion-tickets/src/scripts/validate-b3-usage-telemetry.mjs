import assert from "node:assert/strict";
import { buildB3UsageTelemetry } from "../monitoring/b3-usage-telemetry.mjs";

const thresholds = {
  warningTokens: 1000,
  criticalTokens: 2000,
  warningCostUsd: 0.1,
  criticalCostUsd: 0.5,
};

const normal = buildB3UsageTelemetry({
  jobId: "job_usage_normal",
  model: "gemini-test",
  attempt: 1,
  usage: {
    promptTokens: 400,
    completionTokens: 100,
    totalTokens: 500,
    estimatedCostUsd: null,
    costEstimationRequested: false,
    costCalculated: false,
  },
  thresholds,
});
assert.equal(normal.severity, "info");
assert.equal(normal.estimatedCostUsd, null);
assert.equal(normal.costEstimationRequested, false);

const tokenWarning = buildB3UsageTelemetry({
  usage: { totalTokens: 1000, costCalculated: false },
  thresholds,
});
assert.equal(tokenWarning.severity, "warning");

const tokenCritical = buildB3UsageTelemetry({
  usage: { totalTokens: 2500, costCalculated: false },
  thresholds,
});
assert.equal(tokenCritical.severity, "critical");

const costCritical = buildB3UsageTelemetry({
  usage: { totalTokens: 10, estimatedCostUsd: 0.75, costCalculated: true },
  thresholds,
});
assert.equal(costCritical.severity, "critical");

const ignoredEstimate = buildB3UsageTelemetry({
  usage: { totalTokens: 10, estimatedCostUsd: 100, costCalculated: false },
  thresholds,
});
assert.equal(ignoredEstimate.severity, "info");
assert.equal(buildB3UsageTelemetry({ usage: null, thresholds }), null);

console.log(JSON.stringify({
  ok: true,
  normal: normal.severity,
  tokenWarning: tokenWarning.severity,
  tokenCritical: tokenCritical.severity,
  costCritical: costCritical.severity,
  unpricedCostIgnored: ignoredEstimate.severity,
}, null, 2));
