export const RETENTION_ACTIONS = Object.freeze({
  KEEP: "keep",
  EXPIRE_JOB: "expire_job",
  PURGE_JOB: "purge_job",
  EXPIRE_COMMAND: "expire_command",
  DELETE_COMMAND: "delete_command",
  DELETE_REGISTRY_CANDIDATE: "delete_registry_candidate",
  DELETE_STORAGE_OBJECT: "delete_storage_object",
});

const actionableStatuses = new Set([
  "pending",
  "retry_scheduled",
  "ocr_review_required",
  "needs_user_action",
  "fallback_required",
  "capa_c_resume_requested",
]);
const leasedStatuses = new Set(["ocr_processing", "portal_processing", "capa_c_preparing"]);
const purgeableTerminalStatuses = new Set(["failed", "cancelled", "expired"]);

export function evaluateJobRetention(
  job,
  {
    now = new Date(),
    actionableDays = 5,
    abandonedPurgeDays = 90,
    purgeAbandonedJobs = false,
  } = {},
) {
  const status = clean(job?.status);
  const referenceDate = toDate(job?.updatedAt) ?? toDate(job?.createdAt);

  if (!referenceDate) {
    return keep("missing_reference_date");
  }

  const ageMs = Math.max(0, now.getTime() - referenceDate.getTime());
  const ageDays = ageMs / 86400000;

  if (leasedStatuses.has(status)) {
    return keep("lease_recovery_owns_processing_job", { ageDays });
  }

  if (actionableStatuses.has(status) && ageDays >= actionableDays) {
    return {
      action: RETENTION_ACTIONS.EXPIRE_JOB,
      reason: "inactive_actionable_job",
      ageDays,
      referenceDate: referenceDate.toISOString(),
    };
  }

  if (purgeAbandonedJobs && purgeableTerminalStatuses.has(status) && ageDays >= abandonedPurgeDays) {
    return {
      action: RETENTION_ACTIONS.PURGE_JOB,
      reason: "abandoned_terminal_job",
      ageDays,
      referenceDate: referenceDate.toISOString(),
    };
  }

  return keep("within_retention_window", { ageDays });
}

export function buildExpiredJobPatch({ now = new Date(), actionableDays = 5 } = {}) {
  return {
    status: "expired",
    workflowStage: "complete",
    statusMessage: `La solicitud caducó después de ${actionableDays} días sin actividad.`,
    expirationReason: "inactive_actionable_job",
    expiredAt: now,
    claimedBy: null,
    claimId: null,
    heartbeatAt: null,
    leaseExpiresAt: null,
    retryAt: null,
  };
}

export function evaluateStorageObjectRetention(
  object,
  {
    now = new Date(),
    ticketImageDays = 30,
    portalArtifactDays = 7,
  } = {},
) {
  const name = String(object?.name ?? "");
  const updatedAt = toDate(object?.updatedAt ?? object?.updated ?? object?.timeCreated);

  if (!updatedAt) {
    return keep("missing_storage_date");
  }

  if (name.startsWith("billing-lab/cfdis/")) {
    return keep("cfdi_retained");
  }

  const ageDays = Math.max(0, now.getTime() - updatedAt.getTime()) / 86400000;
  const thresholdDays = name.startsWith("billing-lab/portal-artifacts/")
    ? portalArtifactDays
    : name.startsWith("billing-lab/tickets/") || name.startsWith("billing-api/tickets/")
      ? ticketImageDays
      : null;

  if (thresholdDays === null) {
    return keep("unmanaged_storage_prefix", { ageDays });
  }

  if (ageDays < thresholdDays) {
    return keep("within_retention_window", { ageDays });
  }

  return {
    action: RETENTION_ACTIONS.DELETE_STORAGE_OBJECT,
    reason: name.startsWith("billing-lab/tickets/") || name.startsWith("billing-api/tickets/")
      ? "old_ticket_image"
      : "old_portal_artifact",
    ageDays,
    referenceDate: updatedAt.toISOString(),
  };
}

export function evaluateBillingCommandRetention(
  command,
  {
    now = new Date(),
    pendingDays = 5,
    terminalDays = 30,
  } = {},
) {
  const status = clean(command?.status);
  const referenceDate = toDate(command?.processedAt) ?? toDate(command?.requestedAt);

  if (!referenceDate) {
    return keep("missing_reference_date");
  }

  const ageDays = Math.max(0, now.getTime() - referenceDate.getTime()) / 86400000;

  if (status === "pending" && ageDays >= pendingDays) {
    return {
      action: RETENTION_ACTIONS.EXPIRE_COMMAND,
      reason: "stale_pending_command",
      ageDays,
      referenceDate: referenceDate.toISOString(),
    };
  }

  if (["processed", "rejected"].includes(status) && ageDays >= terminalDays) {
    return {
      action: RETENTION_ACTIONS.DELETE_COMMAND,
      reason: "old_terminal_command",
      ageDays,
      referenceDate: referenceDate.toISOString(),
    };
  }

  return keep("within_retention_window", { ageDays });
}

export function evaluateTemplateCandidateRetention(
  record,
  { now = new Date(), inactiveDays = 45 } = {},
) {
  const status = clean(record?.status ?? record?.candidate?.status);

  if (["active", "active_lab", "replay_passed_1"].includes(status)) {
    return keep("active_template_candidate");
  }

  const referenceDate = toDate(
    record?.sourceCreatedAt ?? record?.candidate?.source?.createdAt ?? record?.updatedAt,
  );
  if (!referenceDate) {
    return keep("missing_reference_date");
  }

  const ageDays = Math.max(0, now.getTime() - referenceDate.getTime()) / 86400000;
  if (ageDays >= inactiveDays) {
    return {
      action: RETENTION_ACTIONS.DELETE_REGISTRY_CANDIDATE,
      reason: "old_inactive_template_candidate",
      ageDays,
      referenceDate: referenceDate.toISOString(),
    };
  }

  return keep("within_retention_window", { ageDays });
}

function keep(reason, extra = {}) {
  return {
    action: RETENTION_ACTIONS.KEEP,
    reason,
    ...extra,
  };
}

function toDate(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value.toDate === "function") {
    return toDate(value.toDate());
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function clean(value) {
  return String(value ?? "").trim().toLowerCase();
}
