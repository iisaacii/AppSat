import { buildFallbackResult, listFallbackReasonPolicies } from "../orchestrator/fallback-policy.mjs";

const policies = listFallbackReasonPolicies();
const errors = [];

for (const policy of policies) {
  const result = buildFallbackResult({
    reason: policy.reason,
    statusMessage: "Probe fallback",
    failure: { type: "probe" },
  });

  for (const field of ["status", "reason", "category", "severity", "retryable", "userAction"]) {
    if (result[field] === null || result[field] === undefined || result[field] === "") {
      errors.push(`${policy.reason} missing ${field}`);
    }
  }

  if (result.status !== "fallback_required") {
    errors.push(`${policy.reason} must use fallback_required`);
  }
}

const unknown = buildFallbackResult({
  reason: "unknown_probe_reason",
  statusMessage: "Probe fallback",
});

if (unknown.category !== "unknown" || unknown.userAction !== "review_ticket_or_continue_manually") {
  errors.push("unknown reason did not use default fallback policy");
}

if (errors.length) {
  console.error(JSON.stringify({ ok: false, errors }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      count: policies.length,
      unknownPolicy: {
        category: unknown.category,
        userAction: unknown.userAction,
      },
    },
    null,
    2,
  ),
);
