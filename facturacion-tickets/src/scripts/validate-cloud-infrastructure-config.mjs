import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildInfrastructurePlan,
  validateInfrastructureConfig,
} from "../deployment/cloud-infrastructure-config.mjs";

const configPath = resolve(
  process.argv.find((value) => value.startsWith("--config="))?.slice(9) ??
    "deployment/cloud-run/staging.infrastructure.json",
);
const rawConfig = JSON.parse(await readFile(configPath, "utf8"));
const plan = buildInfrastructurePlan(rawConfig);

assert.equal(plan.mode, "plan_only");
assert.equal(plan.projectId, "appsat-dev");
assert.equal(plan.region, "us-central1");
assert.equal(plan.resources.subnetwork.cidr, "10.42.0.0/24");
assert.equal(plan.resources.redis.memorySizeGb, 1);
assert.equal(plan.resources.redis.maxmemoryPolicy, "noeviction");
assert.equal(plan.resources.gemini.backend, "developer");
assert.equal(plan.resources.gemini.location, "global");
assert.equal(plan.resources.gemini.runtimeRole, null);
assert.equal(plan.resources.gemini.secret, "appsat-gemini-api-key");
assert.equal(plan.resources.apiServiceToken.secret, null);
assert.equal(plan.resources.apiServiceToken.runtimeRole, null);
assert.ok(plan.requiredApis.includes("aiplatform.googleapis.com"));
assert.equal(plan.runtimeInputsPending.length, 5);

const vertexPlan = buildInfrastructurePlan({
  ...rawConfig,
  geminiBackend: "vertex",
});
assert.equal(vertexPlan.resources.gemini.runtimeRole, "roles/aiplatform.user");
assert.equal(vertexPlan.resources.gemini.secret, null);
assert.equal(vertexPlan.runtimeInputsPending.length, 4);

assert.throws(
  () =>
    validateInfrastructureConfig({
      ...rawConfig,
      redis: { ...rawConfig.redis, maxmemoryPolicy: "volatile-lru" },
    }),
  /must be noeviction/,
);
assert.throws(
  () => validateInfrastructureConfig({ ...rawConfig, subnetCidr: "8.8.8.0/24" }),
  /RFC1918/,
);
assert.throws(
  () => validateInfrastructureConfig({ ...rawConfig, subnetCidr: "10.42.0.1/24" }),
  /aligned/,
);
assert.throws(
  () => validateInfrastructureConfig({ ...rawConfig, allowedOrigins: ["http://localhost"] }),
  /Invalid allowed origin/,
);
assert.throws(
  () =>
    validateInfrastructureConfig({
      ...rawConfig,
      runtimeServiceAccountEmail: "wrong@example.com",
    }),
  /runtimeServiceAccountEmail must be/,
);

console.log(
  JSON.stringify(
    {
      ok: true,
      configPath,
      plan,
      safeguards: [
        "plan_only",
        "no_secrets",
        "private_aligned_subnet",
        "derived_service_account_email",
        "https_origins_only",
        "redis_noeviction",
        "vertex_ai_least_privilege_role",
      ],
    },
    null,
    2,
  ),
);
