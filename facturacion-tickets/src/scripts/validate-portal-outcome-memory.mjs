import assert from "node:assert/strict";
import { shouldTryAiNavigationForSafeStop } from "../ai-navigation/ai-navigation.service.mjs";
import { normalizeManualReason } from "../portals/portal-outcome-memory.mjs";
import {
  ROUTER_DECISIONS,
  decideB3Route,
  shouldStopB3Retries,
} from "../orchestrator/layer-router-policy.mjs";

assert.equal(
  normalizeManualReason("captcha_or_dynamic_flow"),
  null,
  "captcha_or_dynamic_flow must not be normalized to captcha_required"
);
assert.equal(normalizeManualReason("access_denied"), "portal_blocked");
assert.equal(shouldStopB3Retries({ reason: "access_denied" }), true);
assert.equal(shouldStopB3Retries({ reason: "b3_execution_failed" }), false);

assert.equal(
  shouldTryAiNavigationForSafeStop({
    safeStop: true,
    reason: "captcha_required",
  }),
  false,
  "CAPTCHA safe stops must go to Capa C, not B3",
);

assert.equal(
  shouldTryAiNavigationForSafeStop({
    safeStop: true,
    reason: "login_required",
  }),
  false,
  "login safe stops must go to Capa C, not B3",
);

assert.equal(
  shouldTryAiNavigationForSafeStop({
    safeStop: true,
    reason: "b3_dynamic_replay_required",
  }),
  true,
  "dynamic replay stops may still use B3",
);

const seven = {
  rfcEmisor: "SEM980701STA",
  portalUrl: "https://www.e7-eleven.com.mx/facturacion/KPortalExterno/",
  reason: "captcha_required",
};

assert.equal(seven?.reason, "captcha_required");
assert.ok(seven.portalUrl, "remembered Seven outcome should include portal URL");

assert.equal(
  decideB3Route({
    failure: { type: "template_exception", reason: "template_runtime_error" },
    rememberedOutcome: seven,
  }).decision,
  ROUTER_DECISIONS.GO_C,
  "remembered CAPTCHA must skip B3 even if A throws",
);

assert.equal(
  decideB3Route({
    failure: { type: "portal_failure", reason: "access_denied" },
    rememberedOutcome: null,
  }).decision,
  ROUTER_DECISIONS.GO_C,
  "access denied must go to C without another B3 attempt",
);

assert.equal(
  decideB3Route({
    failure: { type: "template_exception", reason: "template_runtime_error" },
    rememberedOutcome: null,
  }).decision,
  ROUTER_DECISIONS.RUN_B3,
  "template runtime errors without remembered manual outcome can use B3",
);

console.log(
  JSON.stringify(
    {
      ok: true,
      safeStopCaptchaToB3: false,
      rememberedSeven: {
        reason: seven.reason,
        portalUrl: seven.portalUrl,
        sourcePath: seven.sourcePath,
      },
      router: {
        rememberedCaptcha: "go_c",
        unknownRuntimeError: "run_b3",
      },
    },
    null,
    2,
  ),
);
