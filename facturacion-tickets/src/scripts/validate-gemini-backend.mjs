import assert from "node:assert/strict";
import {
  buildGeminiClientOptions,
  getGeminiProviderStatus,
} from "../shared/gemini-client.mjs";

const vertex = buildGeminiClientOptions({
  backend: "vertex",
  project: "easysat-dev",
  location: "global",
});
assert.equal(vertex.status.configured, true);
assert.deepEqual(vertex.options, {
  vertexai: true,
  project: "easysat-dev",
  location: "global",
});
assert.equal("apiKey" in vertex.options, false);

const missingVertex = getGeminiProviderStatus({
  backend: "vertex",
  project: "",
  location: "global",
});
assert.equal(missingVertex.configured, false);
assert.equal(missingVertex.reason, "missing_vertex_configuration");

const developer = buildGeminiClientOptions({
  backend: "developer",
  apiKey: "test-only-key",
});
assert.equal(developer.status.configured, true);
assert.deepEqual(developer.options, { apiKey: "test-only-key" });

const missingDeveloper = getGeminiProviderStatus({
  backend: "developer",
  apiKey: "",
});
assert.equal(missingDeveloper.configured, false);
assert.equal(missingDeveloper.reason, "missing_api_key");

console.log(JSON.stringify({
  ok: true,
  backends: ["vertex", "developer"],
  productionAuth: "application_default_credentials",
}));
