import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/i;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Creates the verifier for a server-to-server EasySat token.
 * The configured value is a SHA-256 hash, so the plaintext token never needs
 * to be present in the repository or in the Cloud Run manifest.
 */
export function createBillingApiServiceTokenVerifier({ tokenHash = "", clientId = "external_client" } = {}) {
  const normalizedHash = clean(tokenHash).toLowerCase();
  if (!normalizedHash) return null;
  if (!TOKEN_HASH_PATTERN.test(normalizedHash)) {
    throw new Error("BILLING_API_SERVICE_TOKEN_HASH must be a 64-character SHA-256 hex digest");
  }

  const normalizedClientId = clean(clientId) || "external_client";
  if (!CLIENT_ID_PATTERN.test(normalizedClientId)) {
    throw new Error("BILLING_API_SERVICE_TOKEN_CLIENT_ID has an invalid shape");
  }

  const expected = Buffer.from(normalizedHash, "hex");

  return async function verifyBillingApiServiceToken(token) {
    const candidate = Buffer.from(hashBillingApiServiceToken(token), "hex");
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      return null;
    }

    return {
      uid: `api_${normalizedClientId}`,
      authType: "service_token",
      clientId: normalizedClientId,
    };
  };
}

export function hashBillingApiServiceToken(token) {
  const normalizedToken = clean(token);
  if (!normalizedToken) throw new Error("A service token cannot be empty");
  return createHash("sha256").update(normalizedToken, "utf8").digest("hex");
}

export function generateBillingApiServiceToken() {
  const token = `es_${randomBytes(32).toString("base64url")}`;
  return { token, sha256: hashBillingApiServiceToken(token) };
}

function clean(value) {
  return String(value ?? "").trim();
}
