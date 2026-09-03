import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertSafeExternalUrl,
  assertTrustedTicketFileUrl,
  isPrivateOrReservedIp,
  validateExternalUrlStructure,
} from "../security/external-url-policy.mjs";
import { buildFlutterWebviewHandoff } from "../user-action/flutter-webview-handoff.mjs";

const uid = "owner_123";
const bucketName = "appsat-dev.firebasestorage.app";
const ticketUrl =
  "https://firebasestorage.googleapis.com/v0/b/appsat-dev.firebasestorage.app/o/" +
  "billing-lab%2Ftickets%2Fowner_123%2Fjob-1.jpg?alt=media&token=test-token";

assert.equal(validateExternalUrlStructure("https://example.com/form").hostname, "example.com");
assert.equal(assertTrustedTicketFileUrl(ticketUrl, { uid, bucketName }).href, ticketUrl);

for (const value of [
  "javascript:alert(1)",
  "data:text/html,hello",
  "https://user:pass@example.com",
  "http://localhost/admin",
  "http://127.0.0.1/admin",
  "http://10.0.0.8/admin",
  "http://169.254.169.254/latest/meta-data",
  "http://[::1]/admin",
  "https://portal.internal/form",
  "https://portal.example.test/form",
]) {
  assert.throws(() => validateExternalUrlStructure(value), { name: "UnsafeExternalUrlError" });
}

assert.throws(
  () => assertTrustedTicketFileUrl(ticketUrl.replace("owner_123", "other_user"), { uid, bucketName }),
  { name: "UnsafeExternalUrlError" },
);
assert.throws(
  () => assertTrustedTicketFileUrl(ticketUrl.replace(bucketName, "other.firebasestorage.app"), { uid, bucketName }),
  { name: "UnsafeExternalUrlError" },
);
assert.throws(
  () => assertTrustedTicketFileUrl("https://example.com/ticket.jpg", { uid, bucketName }),
  { name: "UnsafeExternalUrlError" },
);

const fixtureRoot = resolve("src/portals/fixtures");
const fixtureUrl = pathToFileURL(resolve(fixtureRoot, "oxxo-demo-portal.html")).href;
assert.equal(
  validateExternalUrlStructure(fixtureUrl, { allowFile: true, allowedFileRoots: [fixtureRoot] }).protocol,
  "file:",
);
assert.throws(
  () => validateExternalUrlStructure(pathToFileURL(resolve("package.json")).href, {
    allowFile: true,
    allowedFileRoots: [fixtureRoot],
  }),
  { name: "UnsafeExternalUrlError" },
);

for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.1.1", "::1"]) {
  assert.equal(isPrivateOrReservedIp(ip), true, `${ip} must be blocked`);
}
assert.equal(isPrivateOrReservedIp("8.8.8.8"), false);
await assert.rejects(() => assertSafeExternalUrl("http://127.0.0.1/admin"), {
  name: "UnsafeExternalUrlError",
});

const handoff = buildFlutterWebviewHandoff({
  reason: "captcha_required",
  checkpoint: {
    currentUrl: "https://facturacion.example.com/captcha",
    portalUrl: "https://facturacion.example.com",
  },
  template: {
    portalUrl: "https://facturacion.example.com",
    steps: [{ type: "goto", url: "https://paso.facturacion.example.com/form" }],
  },
});
assert.deepEqual(handoff.allowedAutofillHosts, [
  "facturacion.example.com",
  "paso.facturacion.example.com",
]);
assert.equal(
  buildFlutterWebviewHandoff({ checkpoint: { currentUrl: "http://127.0.0.1/admin" } }),
  null,
);

console.log(
  JSON.stringify(
    {
      ok: true,
      ticketUrlPolicy: "firebase_bucket_uid_path",
      privateNetworks: "blocked",
      fileFixtures: "scoped_to_fixture_root",
      webviewAutofill: "host_allowlist",
    },
    null,
    2,
  ),
);
