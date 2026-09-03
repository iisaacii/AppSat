import { normalizeUserActionReason } from "./user-action-policy.mjs";

export const ROUTER_DECISIONS = {
  RUN_A: "run_a",
  RUN_B3: "run_b3",
  GO_C: "go_c",
  RESOLVED: "resolved",
  RETRY: "retry",
};

const B3_RECOVERABLE_REASONS = new Set([
  "unknown_emitter",
  "portal_template_missing",
  "template_runtime_error",
  "cfdi_artifact_missing",
  "template_safe_stop",
  "invoice_preview_not_available",
  "tax_form_disabled_after_ticket_validation",
  "b3_dynamic_replay_required",
  "b3_selector_extraction_required",
]);

const B3_BLOCKED_REASONS = new Set([
  "captcha_required",
  "login_required",
  "portal_blocked",
  "access_denied",
  "http_403",
  "forbidden",
  "ticket_expired",
  "fiscal_rule_blocked",
  "ticket_outside_current_fiscal_year",
  "cfdi_use_not_supported_by_regime",
  "cfdi_use_not_available",
  "tax_regime_not_available",
]);

export function decideRememberedOutcomeRoute({ rememberedOutcome } = {}) {
  const reason = normalizeUserActionReason(rememberedOutcome?.reason);

  if (!rememberedOutcome || !reason) {
    return {
      decision: null,
      reason: null,
    };
  }

  if (["captcha_required", "login_required", "portal_blocked"].includes(reason)) {
    return {
      decision: ROUTER_DECISIONS.GO_C,
      reason,
    };
  }

  return {
    decision: null,
    reason,
  };
}

export function decideB3Route({ failure = {}, rememberedOutcome = null } = {}) {
  const rememberedRoute = decideRememberedOutcomeRoute({ rememberedOutcome });

  if (rememberedRoute.decision) {
    return {
      decision: rememberedRoute.decision,
      reason: rememberedRoute.reason,
      source: "remembered_outcome",
    };
  }

  const reason = failure?.reason ?? failure?.type ?? null;

  if (B3_BLOCKED_REASONS.has(reason)) {
    return {
      decision: ROUTER_DECISIONS.GO_C,
      reason,
      source: "blocked_reason",
    };
  }

  if (B3_RECOVERABLE_REASONS.has(reason) || failure?.type === "portal_missing") {
    return {
      decision: ROUTER_DECISIONS.RUN_B3,
      reason,
      source: "recoverable_failure",
    };
  }

  return {
    decision: ROUTER_DECISIONS.GO_C,
    reason,
    source: "unhandled_failure",
  };
}

export function isManualOrResolvedOutcome(reason) {
  const normalized = normalizeUserActionReason(reason);

  return ["captcha_required", "login_required", "portal_blocked", "ticket_already_invoiced"].includes(normalized);
}

export function shouldStopB3Retries(result = {}) {
  return isManualOrResolvedOutcome(result.reason);
}
