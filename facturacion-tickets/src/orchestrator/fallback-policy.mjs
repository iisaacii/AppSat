const fallbackReasonPolicies = {
  portal_template_missing: {
    category: "portal_discovery",
    userAction: "provide_portal_url_or_manual_invoice_link",
    retryable: false,
    severity: "manual",
  },
  ai_portal_url_required: {
    category: "portal_discovery",
    userAction: "provide_portal_url_or_manual_invoice_link",
    retryable: false,
    severity: "manual",
  },
  ai_navigation_disabled: {
    category: "configuration",
    userAction: "contact_support_or_retry_later",
    retryable: false,
    severity: "support",
  },
  ai_provider_not_configured: {
    category: "configuration",
    userAction: "contact_support_or_retry_later",
    retryable: false,
    severity: "support",
  },
  ai_provider_error: {
    category: "ai_navigation",
    userAction: "retry_or_continue_manually",
    retryable: true,
    severity: "temporary",
  },
  ai_action_plan_invalid: {
    category: "ai_navigation",
    userAction: "retry_or_continue_manually",
    retryable: true,
    severity: "temporary",
  },
  ai_action_execution_failed: {
    category: "ai_navigation",
    userAction: "retry_or_continue_manually",
    retryable: true,
    severity: "temporary",
  },
  ai_final_submit_approval_required: {
    category: "approval",
    userAction: "review_and_approve_final_submit",
    retryable: false,
    severity: "manual",
  },
  ai_preview_ready: {
    category: "approval",
    userAction: "review_and_approve_final_submit",
    retryable: false,
    severity: "manual",
  },
  ai_cannot_solve: {
    category: "portal_blocked",
    userAction: "continue_manually_or_contact_support",
    retryable: false,
    severity: "manual",
  },
  ai_max_turns_reached: {
    category: "ai_navigation",
    userAction: "retry_or_continue_manually",
    retryable: true,
    severity: "temporary",
  },
  ai_navigation_unresolved: {
    category: "ai_navigation",
    userAction: "retry_or_continue_manually",
    retryable: true,
    severity: "temporary",
  },
  ocr_ticket_fields_required: {
    category: "ocr_review",
    userAction: "review_ticket_fields",
    retryable: false,
    severity: "manual",
  },
};

const defaultPolicy = {
  category: "unknown",
  userAction: "review_ticket_or_continue_manually",
  retryable: false,
  severity: "manual",
};

export function buildFallbackResult({ reason, statusMessage, failure, details = null }) {
  const normalizedReason = normalizeReason(reason);
  const policy = fallbackReasonPolicies[normalizedReason] ?? defaultPolicy;

  return {
    status: "fallback_required",
    reason: normalizedReason,
    category: policy.category,
    severity: policy.severity,
    retryable: policy.retryable,
    statusMessage,
    failure: failure ?? null,
    details,
    userAction: policy.userAction,
  };
}

export function listFallbackReasonPolicies() {
  return Object.entries(fallbackReasonPolicies)
    .map(([reason, policy]) => ({
      reason,
      ...policy,
    }))
    .sort((a, b) => a.reason.localeCompare(b.reason));
}

function normalizeReason(reason) {
  const value = String(reason ?? "").trim();
  return value || "ai_navigation_unresolved";
}
