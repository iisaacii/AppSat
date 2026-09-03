import { generateBillingApiServiceToken } from "../api/service-token-auth.mjs";

const { token, sha256 } = generateBillingApiServiceToken();

console.log("AppSat service token generated. Store the plaintext only in External client's backend secret store.");
console.log(`token=${token}`);
console.log(`sha256=${sha256}`);
console.log("Configure only sha256 in BILLING_API_SERVICE_TOKEN_HASH / Secret Manager.");
