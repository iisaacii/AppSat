import assert from "node:assert/strict";
import { parse } from "yaml";
import { generateCloudRunManifests } from "../deployment/cloud-run-manifests.mjs";

const digest = (character) => character.repeat(64);
const config = {
  projectId: "easysat-dev",
  region: "us-central1",
  namePrefix: "easysat-billing-stg",
  network: "easysat-staging",
  subnetwork: "easysat-staging-us-central1",
  redisHost: "10.10.0.5",
  runtimeServiceAccount: "easysat-billing-runtime@easysat-dev.iam.gserviceaccount.com",
  releaseId: "stg-test-release",
  apiPublicAccess: true,
  allowedOrigins: ["https://easysat-dev.web.app"],
  geminiBackend: "vertex",
  geminiVertexLocation: "global",
  geminiSecret: { name: "easysat-gemini-api-key", version: "1" },
  images: {
    api: `us-central1-docker.pkg.dev/easysat-dev/easysat/billing-api@sha256:${digest("a")}`,
    ocr: `us-central1-docker.pkg.dev/easysat-dev/easysat/billing-ocr@sha256:${digest("b")}`,
    browser: `us-central1-docker.pkg.dev/easysat-dev/easysat/billing-browser@sha256:${digest("c")}`,
  },
};

const generated = generateCloudRunManifests(config);
assert.equal(Object.keys(generated.manifests).length, 5);
for (const [fileName, yaml] of Object.entries(generated.manifests)) {
  const parsed = parse(yaml);
  assert.ok(parsed?.apiVersion, `${fileName} must have apiVersion`);
  assert.ok(parsed?.kind, `${fileName} must have kind`);
  assert.ok(parsed?.metadata?.name, `${fileName} must have metadata.name`);
  assert.ok(parsed?.spec?.template?.spec?.containers?.length, `${fileName} must have a container`);
}
assert.match(generated.manifests["api-service.yaml"], /kind: Service/);
assert.match(generated.manifests["api-service.yaml"], /BILLING_API_ALLOWED_ORIGINS/);
assert.match(generated.manifests["api-service.yaml"], /BILLING_RELEASE_ID/);
assert.match(generated.manifests["api-service.yaml"], /run\.googleapis\.com\/invoker-iam-disabled: "true"/);
assert.match(generated.manifests["api-service.yaml"], /run\.googleapis\.com\/default-url-disabled: "false"/);
assert.match(generated.manifests["ocr-worker-pool.yaml"], /--worker-lane=ocr/);
assert.match(generated.manifests["portal-worker-pool.yaml"], /--worker-lane=portal/);
assert.match(generated.manifests["capa-c-worker-pool.yaml"], /--worker-lane=capa_c/);
assert.match(generated.manifests["capa-c-worker-pool.yaml"], /CAPA_C_HANDOFF_MODE/);
assert.match(generated.manifests["capa-c-worker-pool.yaml"], /flutter_webview/);
assert.match(generated.manifests["capa-c-worker-pool.yaml"], /CAPA_C_KEEP_BROWSER_OPEN/);
assert.match(generated.manifests["queue-monitor-worker-pool.yaml"], /monitor-billing-queues/);
assert.match(generated.manifests["portal-worker-pool.yaml"], /B3_BROWSER_USE_DISABLE_DEV_SHM_USAGE/);
assert.match(generated.manifests["portal-worker-pool.yaml"], /B3_BROWSER_USE_DEFAULT_EXTENSIONS/);
assert.match(generated.manifests["portal-worker-pool.yaml"], /BILLING_AUTOPILOT_MODE/);
assert.match(generated.manifests["portal-worker-pool.yaml"], /BILLING_AUTOPILOT_FINAL_SUBMIT/);
assert.match(generated.manifests["ocr-worker-pool.yaml"], /GEMINI_BACKEND/);
assert.match(generated.manifests["ocr-worker-pool.yaml"], /GEMINI_VERTEX_PROJECT/);
assert.match(generated.manifests["ocr-worker-pool.yaml"], /GEMINI_VERTEX_LOCATION/);
assert.doesNotMatch(generated.manifests["ocr-worker-pool.yaml"], /GEMINI_API_KEY/);
assert.doesNotMatch(generated.manifests["portal-worker-pool.yaml"], /secretKeyRef/);
assert.doesNotMatch(JSON.stringify(generated), /GOOGLE_APPLICATION_CREDENTIALS/);
assert.doesNotMatch(JSON.stringify(generated), /\/dev\/shm/);
assert.doesNotMatch(JSON.stringify(generated), /service-account\.json/);

assert.throws(
  () =>
    generateCloudRunManifests({
      ...config,
      images: { ...config.images, browser: "example.invalid/browser:latest" },
    }),
  /immutable @sha256 digest/,
);
assert.throws(
  () => generateCloudRunManifests({ ...config, allowedOrigins: ["http://localhost:52123"] }),
  /Invalid allowed origin/,
);

const developerGenerated = generateCloudRunManifests({
  ...config,
  geminiBackend: "developer",
});
assert.match(developerGenerated.manifests["ocr-worker-pool.yaml"], /GEMINI_API_KEY/);
assert.match(developerGenerated.manifests["portal-worker-pool.yaml"], /secretKeyRef/);

const serviceTokenGenerated = generateCloudRunManifests({
  ...config,
  apiServiceTokenClientId: "external_client",
  apiServiceTokenSecret: {
    name: "appsat-billing-api-token-hash",
    version: "1",
  },
});
assert.match(serviceTokenGenerated.manifests["api-service.yaml"], /BILLING_API_SERVICE_TOKEN_CLIENT_ID/);
assert.match(serviceTokenGenerated.manifests["api-service.yaml"], /BILLING_API_SERVICE_TOKEN_HASH/);
assert.match(serviceTokenGenerated.manifests["api-service.yaml"], /appsat-billing-api-token-hash/);

console.log(
  JSON.stringify(
    {
      ok: true,
      resources: generated.names,
      manifestFiles: Object.keys(generated.manifests),
      safeguards: [
        "immutable_image_digests",
        "application_default_credentials",
        "vertex_ai_adc",
        "developer_api_secret_fallback",
        "guarded_automatic_final_submit",
        "direct_vpc_redis",
        "collection_group_enabled",
        "cloud_run_chromium_compatible",
      ],
    },
    null,
    2,
  ),
);
