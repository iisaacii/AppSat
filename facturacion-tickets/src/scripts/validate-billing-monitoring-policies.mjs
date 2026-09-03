import assert from "node:assert/strict";
import {
  buildBillingMonitoringPolicies,
  normalizeNotificationChannels,
} from "../deployment/billing-monitoring-policies.mjs";

const channel = "projects/easysat-dev/notificationChannels/billing-alerts";
const policies = buildBillingMonitoringPolicies({ notificationChannels: [channel, channel] });

assert.equal(policies.length, 2);
assert.deepEqual(policies.map((entry) => entry.key), ["queue_critical", "b3_usage_critical"]);
assert.deepEqual(policies[0].policy.notificationChannels, [channel]);
assert.match(policies[0].policy.conditions[0].conditionMatchedLog.filter, /billing_queue_alert/);
assert.match(policies[0].policy.conditions[0].conditionMatchedLog.filter, /status="critical"/);
assert.match(policies[1].policy.conditions[0].conditionMatchedLog.filter, /b3_llm_usage/);
assert.match(policies[1].policy.conditions[0].conditionMatchedLog.filter, /severity="critical"/);
assert.equal(policies[0].policy.alertStrategy.notificationRateLimit.period, "300s");
assert.equal(policies[1].policy.alertStrategy.notificationRateLimit.period, "3600s");
assert.throws(
  () => normalizeNotificationChannels(["billing-alerts"]),
  /Invalid Cloud Monitoring notification channel/,
);

console.log(JSON.stringify({
  ok: true,
  policies: policies.map(({ key, policy }) => ({ key, displayName: policy.displayName })),
}));
