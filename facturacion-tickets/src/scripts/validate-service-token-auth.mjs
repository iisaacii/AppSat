import assert from "node:assert/strict";
import {
  createBillingApiServiceTokenVerifier,
  generateBillingApiServiceToken,
  hashBillingApiServiceToken,
} from "../api/service-token-auth.mjs";

const generated = generateBillingApiServiceToken();
assert.match(generated.token, /^es_[A-Za-z0-9_-]{43}$/);
assert.equal(generated.sha256, hashBillingApiServiceToken(generated.token));

const verify = createBillingApiServiceTokenVerifier({
  tokenHash: generated.sha256,
  clientId: "external_client",
});
assert.ok(verify);
assert.deepEqual(await verify(generated.token), {
  uid: "api_external_client",
  authType: "service_token",
  clientId: "external_client",
});
assert.equal(await verify("es_invalid"), null);
assert.equal(createBillingApiServiceTokenVerifier({ tokenHash: "" }), null);
assert.throws(
  () => createBillingApiServiceTokenVerifier({ tokenHash: "not-a-hash" }),
  /SHA-256/,
);

console.log("AppSat service-token authentication validation passed.");
