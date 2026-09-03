export function getEnv(name, fallback = undefined) {
  return process.env[name] ?? fallback;
}

export function getCliOption(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

export function getJobStoreMode() {
  return getCliOption("store") ?? getEnv("BILLING_JOB_STORE", "mock");
}

export function getBillingApiPort() {
  return Math.max(1, Math.floor(getNumberEnv("PORT", getNumberEnv("BILLING_API_PORT", 8080))));
}

export function getBillingApiAllowedOrigins() {
  return String(
    getEnv(
      "BILLING_API_ALLOWED_ORIGINS",
      "https://easysat-dev.web.app,http://127.0.0.1:52123,http://localhost:52123",
    ),
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function getBillingApiBodyLimitBytes() {
  return Math.max(1024, Math.floor(getNumberEnv("BILLING_API_BODY_LIMIT_BYTES", 65536)));
}

export function getBillingApiTicketLimitBytes() {
  return Math.max(
    1024 * 1024,
    Math.floor(getNumberEnv("BILLING_API_TICKET_LIMIT_BYTES", 10 * 1024 * 1024)),
  );
}

export function getBillingApiRateLimitPerMinute() {
  return Math.max(1, Math.floor(getNumberEnv("BILLING_API_RATE_LIMIT_PER_MINUTE", 120)));
}

export function getBillingApiServiceTokenHash() {
  return getEnv("BILLING_API_SERVICE_TOKEN_HASH", "").trim();
}

export function getBillingApiServiceTokenClientId() {
  return getEnv("BILLING_API_SERVICE_TOKEN_CLIENT_ID", "external_client").trim() || "external_client";
}

export function shouldCheckRevokedFirebaseTokens() {
  return getEnv("BILLING_API_CHECK_REVOKED_TOKENS", "false").toLowerCase() === "true";
}

export function getOcrEngine() {
  return getCliOption("ocr") ?? getEnv("OCR_ENGINE", "mock");
}

export function isGeminiTicketVisionEnabled() {
  return getEnv("OCR_GEMINI_VISION_ENABLED", "true").toLowerCase() === "true";
}

export function getGeminiTicketVisionModel() {
  return getEnv("OCR_GEMINI_VISION_MODEL", getAiGeminiModel());
}

export function getAutonomousOcrMaxCandidateSets() {
  return Math.max(1, Math.min(8, Math.floor(getNumberEnv("OCR_AUTONOMOUS_MAX_CANDIDATE_SETS", 4))));
}

export function getAutonomousOcrMinimumConfidence() {
  return Math.max(0, Math.min(1, getNumberEnv("OCR_AUTONOMOUS_MIN_CONFIDENCE", 0.52)));
}

export function getDocumentAiExpenseProcessorName() {
  return getEnv("DOCUMENT_AI_EXPENSE_PROCESSOR", "").trim();
}

export function getPortalRunnerMode() {
  return getCliOption("portal-runner") ?? getEnv("PORTAL_RUNNER_MODE", "mock");
}

export function getAiNavigatorMode() {
  return getCliOption("ai-navigator") ?? getEnv("AI_NAVIGATOR_MODE", "mock");
}

export function getAiGeminiModel() {
  return getEnv("AI_GEMINI_MODEL", "gemini-3.1-flash-lite");
}

export function getGeminiApiKey() {
  return getEnv("GEMINI_API_KEY") ?? getEnv("GOOGLE_API_KEY") ?? getEnv("GOOGLE_GENERATIVE_AI_API_KEY");
}

export function getGeminiBackend() {
  const backend = String(getEnv("GEMINI_BACKEND", "developer")).trim().toLowerCase();

  if (["developer", "api_key", "gemini_api"].includes(backend)) {
    return "developer";
  }

  if (["vertex", "vertex_ai"].includes(backend)) {
    return "vertex";
  }

  throw new Error("GEMINI_BACKEND must be developer or vertex.");
}

export function getGeminiVertexProject() {
  return String(
    getEnv(
      "GEMINI_VERTEX_PROJECT",
      getEnv("GOOGLE_CLOUD_PROJECT", getEnv("GCLOUD_PROJECT", getEnv("FIREBASE_PROJECT_ID", ""))),
    ),
  ).trim();
}

export function getGeminiVertexLocation() {
  return String(getEnv("GEMINI_VERTEX_LOCATION", getEnv("GOOGLE_CLOUD_LOCATION", "global"))).trim();
}

export function getAiGeminiThinkingBudget() {
  return getNumberEnv("AI_GEMINI_THINKING_BUDGET", 0);
}

export function getAiGeminiRequestTimeoutMs() {
  return getNumberEnv("AI_GEMINI_REQUEST_TIMEOUT_MS", 120000);
}

export function getAiNavigatorMaxTurns() {
  return getNumberEnv("AI_NAVIGATOR_MAX_TURNS", 8);
}

export function getAiNavigatorMaxActions() {
  return getNumberEnv("AI_NAVIGATOR_MAX_ACTIONS", 20);
}

export function isAiFinalSubmitEnabled() {
  return getEnv("AI_NAVIGATOR_ALLOW_FINAL_SUBMIT", "false").toLowerCase() === "true";
}

export function isStagehandLabEnabled() {
  return getEnv("STAGEHAND_LAB_ENABLED", "false").toLowerCase() === "true";
}

export function getStagehandEnv() {
  return getEnv("STAGEHAND_ENV", "LOCAL").toUpperCase();
}

export function getStagehandModel() {
  return getEnv("STAGEHAND_MODEL", "google/gemini-3.1-flash-lite");
}

export function getBrowserbaseApiKey() {
  return getEnv("BROWSERBASE_API_KEY");
}

export function getBrowserbaseProjectId() {
  return getEnv("BROWSERBASE_PROJECT_ID");
}

export function getBrowserbaseRegion() {
  return getEnv("BROWSERBASE_REGION", "us-west-2");
}

export function shouldUseBrowserbaseProxies() {
  return getEnv("BROWSERBASE_PROXIES", "false").toLowerCase() === "true";
}

export function shouldUseBrowserbaseCaptchaSolving() {
  return getEnv("BROWSERBASE_SOLVE_CAPTCHAS", "false").toLowerCase() === "true";
}

export function shouldUseBrowserbaseAdvancedStealth() {
  return getEnv("BROWSERBASE_ADVANCED_STEALTH", "false").toLowerCase() === "true";
}

export function shouldRecordBrowserbaseSession() {
  return getEnv("BROWSERBASE_RECORD_SESSION", "true").toLowerCase() === "true";
}

export function getStagehandCacheDir() {
  return getEnv("STAGEHAND_CACHE_DIR", "data/stagehand-cache");
}

export function getStagehandRegistryDir() {
  return getEnv("STAGEHAND_REGISTRY_DIR", "data/stagehand-registry");
}

export function getStagehandMaxSteps() {
  return getNumberEnv("STAGEHAND_MAX_STEPS", 40);
}

export function isStagehandFinalSubmitEnabled() {
  return getEnv("STAGEHAND_ALLOW_FINAL_SUBMIT", "false").toLowerCase() === "true";
}

export function shouldUseLearnedPortalTemplates() {
  return getEnv("PORTAL_USE_LEARNED_TEMPLATES", "true").toLowerCase() === "true";
}

export function getPortalKnowledgeStoreMode() {
  const fallback = getJobStoreMode() === "firestore" ? "dual" : "local";
  const mode = String(getEnv("PORTAL_KNOWLEDGE_STORE", fallback)).trim().toLowerCase();

  if (!["local", "dual", "firestore"].includes(mode)) {
    throw new Error("PORTAL_KNOWLEDGE_STORE must be local, dual or firestore.");
  }

  return mode;
}

export function getPortalKnowledgeReadLimit() {
  return Math.max(1, Math.floor(getNumberEnv("PORTAL_KNOWLEDGE_READ_LIMIT", 250)));
}

export function getRedisUrl() {
  return getEnv("REDIS_URL", "redis://127.0.0.1:6379");
}

export function getRedisConnectTimeoutMs() {
  return Math.max(250, Math.floor(getNumberEnv("REDIS_CONNECT_TIMEOUT_MS", 5000)));
}

export function getBillingDispatchMode() {
  const mode = String(getEnv("BILLING_DISPATCH_MODE", "poll")).trim().toLowerCase();

  if (!["poll", "hybrid", "queue"].includes(mode)) {
    throw new Error("BILLING_DISPATCH_MODE must be poll, hybrid or queue.");
  }

  return mode;
}

export function getBillingQueuePrefix() {
  return String(getEnv("BILLING_QUEUE_PREFIX", "easysat:billing"))
    .trim()
    .replace(/[^a-zA-Z0-9:_-]/g, "-");
}

export function getBillingQueueFallbackPollMs() {
  return Math.max(5000, Math.floor(getNumberEnv("BILLING_QUEUE_FALLBACK_POLL_MS", 30000)));
}

export function getBillingQueueAttempts() {
  return Math.max(1, Math.min(10, Math.floor(getNumberEnv("BILLING_QUEUE_ATTEMPTS", 3))));
}

export function getBillingQueueBackoffMs() {
  return Math.max(250, Math.floor(getNumberEnv("BILLING_QUEUE_BACKOFF_MS", 1000)));
}

export function getBillingQueueCompletedRetentionSeconds() {
  return Math.max(60, Math.floor(getNumberEnv("BILLING_QUEUE_COMPLETED_RETENTION_SECONDS", 86400)));
}

export function getBillingQueueFailedRetentionSeconds() {
  return Math.max(300, Math.floor(getNumberEnv("BILLING_QUEUE_FAILED_RETENTION_SECONDS", 604800)));
}

export function getBillingMonitorIntervalMs() {
  return Math.max(5000, Math.floor(getNumberEnv("BILLING_MONITOR_INTERVAL_MS", 30000)));
}

export function getBillingMonitorStartupGraceMs() {
  return Math.max(0, Math.floor(getNumberEnv("BILLING_MONITOR_STARTUP_GRACE_MS", 60000)));
}

export function getBillingMonitorAlertCooldownMs() {
  return Math.max(10000, Math.floor(getNumberEnv("BILLING_MONITOR_ALERT_COOLDOWN_MS", 300000)));
}

export function shouldBillingMonitorRequireWorkers() {
  return getEnv("BILLING_MONITOR_REQUIRE_WORKERS", "false").toLowerCase() === "true";
}

export function getBillingQueueHealthThresholds() {
  const warningWaiting = Math.max(1, Math.floor(getNumberEnv("BILLING_QUEUE_WARN_WAITING", 25)));
  const warningFailures = Math.max(1, Math.floor(getNumberEnv("BILLING_QUEUE_WARN_RECENT_FAILURES", 3)));

  return {
    warningWaiting,
    criticalWaiting: Math.max(
      warningWaiting,
      Math.floor(getNumberEnv("BILLING_QUEUE_CRITICAL_WAITING", 100)),
    ),
    warningOldestMs: Math.max(1000, Math.floor(getNumberEnv("BILLING_QUEUE_WARN_OLDEST_MS", 120000))),
    criticalOldestMs: Math.max(1000, Math.floor(getNumberEnv("BILLING_QUEUE_CRITICAL_OLDEST_MS", 600000))),
    warningActiveMs: Math.max(1000, Math.floor(getNumberEnv("BILLING_QUEUE_WARN_ACTIVE_MS", 1200000))),
    criticalActiveMs: Math.max(1000, Math.floor(getNumberEnv("BILLING_QUEUE_CRITICAL_ACTIVE_MS", 2700000))),
    warningDelayedOverdueMs: Math.max(
      1000,
      Math.floor(getNumberEnv("BILLING_QUEUE_WARN_DELAYED_OVERDUE_MS", 60000)),
    ),
    criticalDelayedOverdueMs: Math.max(
      1000,
      Math.floor(getNumberEnv("BILLING_QUEUE_CRITICAL_DELAYED_OVERDUE_MS", 300000)),
    ),
    failureWindowMs: Math.max(
      60000,
      Math.floor(getNumberEnv("BILLING_QUEUE_FAILURE_WINDOW_MS", 900000)),
    ),
    warningFailures,
    criticalFailures: Math.max(
      warningFailures,
      Math.floor(getNumberEnv("BILLING_QUEUE_CRITICAL_RECENT_FAILURES", 10)),
    ),
  };
}

export function getB3UsageThresholds() {
  const warningTokens = Math.max(1, Math.floor(getNumberEnv("B3_USAGE_WARN_TOTAL_TOKENS", 200000)));
  const warningCostUsd = Math.max(0.000001, getNumberEnv("B3_USAGE_WARN_ESTIMATED_COST_USD", 0.25));

  return {
    warningTokens,
    criticalTokens: Math.max(
      warningTokens,
      Math.floor(getNumberEnv("B3_USAGE_CRITICAL_TOTAL_TOKENS", 500000)),
    ),
    warningCostUsd,
    criticalCostUsd: Math.max(
      warningCostUsd,
      getNumberEnv("B3_USAGE_CRITICAL_ESTIMATED_COST_USD", 1),
    ),
  };
}

export function getPortalRateLimitBackend() {
  const backend = String(getEnv("PORTAL_RATE_LIMIT_BACKEND", "local")).trim().toLowerCase();

  if (!["local", "redis"].includes(backend)) {
    throw new Error("PORTAL_RATE_LIMIT_BACKEND must be local or redis.");
  }

  return backend;
}

export function isPortalRateLimitRedisRequired() {
  return getEnv("PORTAL_RATE_LIMIT_REDIS_REQUIRED", "false").toLowerCase() === "true";
}

export function getPortalRateLimitNamespace() {
  return String(getEnv("PORTAL_RATE_LIMIT_NAMESPACE", "easysat:billing:portal"))
    .trim()
    .replace(/[^a-zA-Z0-9:_-]/g, "-");
}

export function getPortalRateLimitLeaseMs() {
  return Math.max(30000, Math.floor(getNumberEnv("PORTAL_RATE_LIMIT_LEASE_MS", 120000)));
}

export function getPortalRateLimitPollMs() {
  return Math.max(50, Math.floor(getNumberEnv("PORTAL_RATE_LIMIT_POLL_MS", 250)));
}

export function getPortalRateLimitAcquireTimeoutMs() {
  return Math.max(1000, Math.floor(getNumberEnv("PORTAL_RATE_LIMIT_ACQUIRE_TIMEOUT_MS", 900000)));
}

export function getPortalOutcomeMaxAgeDays() {
  return Math.max(1, Math.floor(getNumberEnv("PORTAL_OUTCOME_MAX_AGE_DAYS", 180)));
}

export function shouldAutopromoteLearnedTemplates() {
  return getEnv("AI_LEARNED_TEMPLATE_AUTOPROMOTE", "true").toLowerCase() === "true";
}

export function getBillingAutopilotMode() {
  return getEnv("BILLING_AUTOPILOT_MODE", "safe").toLowerCase();
}

export function isBillingAutopilotEnabled() {
  return getBillingAutopilotMode() !== "disabled";
}

export function isBillingAutopilotFinalSubmitEnabled() {
  return getEnv("BILLING_AUTOPILOT_FINAL_SUBMIT", "true").toLowerCase() === "true";
}

export function getBillingPortalVariantMaxAttempts() {
  return getNumberEnv("BILLING_PORTAL_VARIANT_MAX_ATTEMPTS", 4);
}

export function isAiNavigationEnabled() {
  return getAiNavigatorMode() !== "disabled";
}

export function shouldForceAiNavigation() {
  return getEnv("BILLING_FORCE_AI_NAVIGATION", "false").toLowerCase() === "true";
}

export function isPortalDiscoveryEnabled() {
  return getEnv("PORTAL_DISCOVERY_ENABLED", "true").toLowerCase() === "true";
}

export function isPortalDiscoveryQrEnabled() {
  return getEnv("PORTAL_DISCOVERY_QR_ENABLED", "true").toLowerCase() === "true";
}

export function isPortalDiscoveryProbeEnabled() {
  return getEnv("PORTAL_DISCOVERY_PROBE_ENABLED", "true").toLowerCase() === "true";
}

export function getPortalDiscoveryProbeTimeoutMs() {
  return getNumberEnv("PORTAL_DISCOVERY_PROBE_TIMEOUT_MS", 12000);
}

export function getCfdiStorageMode() {
  return (
    getCliOption("cfdi-storage") ??
    getEnv("CFDI_STORAGE_MODE", getJobStoreMode() === "firestore" ? "firebase" : "mock")
  );
}

export function getCfdiStoragePrefix() {
  return getEnv("CFDI_STORAGE_PREFIX", "billing-lab/cfdis");
}

export function getPortalArtifactStoragePrefix() {
  return getEnv("PORTAL_ARTIFACT_STORAGE_PREFIX", "billing-lab/portal-artifacts");
}

export function getFirebaseStorageBucketName() {
  return normalizeBucketName(getEnv("FIREBASE_STORAGE_BUCKET", "easysat-dev.firebasestorage.app"));
}

export function getPortalArtifactsDir() {
  return getEnv("PORTAL_ARTIFACTS_DIR", "artifacts/portal-runs");
}

export function isPortalFinalSubmitEnabled() {
  return getEnv("PORTAL_ALLOW_FINAL_SUBMIT", "false").toLowerCase() === "true";
}

export function isFixtureTemplateFinalSubmitEnabled() {
  return getEnv("PORTAL_FIXTURE_ALLOW_TEMPLATE_FINAL_SUBMIT", "false").toLowerCase() === "true";
}

export function isRealTemplateFinalSubmitEnabled() {
  return (
    getEnv("PORTAL_REAL_ALLOW_TEMPLATE_FINAL_SUBMIT", "false").toLowerCase() === "true" &&
    getEnv("PORTAL_REAL_FINAL_SUBMIT_CONFIRM") === "CONFIRMO emitir factura real OXXO"
  );
}

export function isAutopilotTemplateFinalSubmitEnabled() {
  return (
    getEnv("PORTAL_AUTOPILOT_ALLOW_TEMPLATE_FINAL_SUBMIT", "false").toLowerCase() === "true" &&
    getEnv("PORTAL_AUTOPILOT_FINAL_SUBMIT_CONFIRM") === "CONFIRMO autopilot facturacion real"
  );
}

export function isDemoFinalSubmitApproved() {
  return getEnv("FIRESTORE_DEMO_APPROVE_FINAL_SUBMIT", "false").toLowerCase() === "true";
}

export function getWorkerId() {
  return getEnv("WORKER_ID", `worker-${process.pid}`);
}

export function getWorkerLeaseDurationMs() {
  return getNumberEnv("WORKER_LEASE_DURATION_MS", 120000);
}

export function getWorkerHeartbeatIntervalMs() {
  return getNumberEnv("WORKER_HEARTBEAT_INTERVAL_MS", 30000);
}

export function getWorkerMaxAttempts() {
  return getNumberEnv("WORKER_MAX_ATTEMPTS", 3);
}

export function getWorkerRetryBaseMs() {
  return getNumberEnv("WORKER_RETRY_BASE_MS", 30000);
}

export function getWorkerRetryMaxMs() {
  return getNumberEnv("WORKER_RETRY_MAX_MS", 900000);
}

export function getWorkerLane() {
  return getCliOption("worker-lane") ?? getEnv("WORKER_LANE", "all");
}

export function getWorkerConcurrency() {
  const cliValue = Number(getCliOption("worker-concurrency"));
  const value = Number.isFinite(cliValue) && cliValue > 0
    ? cliValue
    : getNumberEnv("WORKER_CONCURRENCY", 1);
  return Math.max(1, Math.floor(value));
}

export function getWorkerCommandBatchSize() {
  return Math.max(1, Math.min(50, Math.floor(getNumberEnv("WORKER_COMMAND_BATCH_SIZE", 10))));
}

export function getActionableJobRetentionDays() {
  return Math.max(1, Math.floor(getNumberEnv("RETENTION_ACTIONABLE_JOB_DAYS", 5)));
}

export function getAbandonedJobPurgeDays() {
  return Math.max(
    getActionableJobRetentionDays() + 1,
    Math.floor(getNumberEnv("RETENTION_ABANDONED_JOB_PURGE_DAYS", 90)),
  );
}

export function getTicketImageRetentionDays() {
  return Math.max(1, Math.floor(getNumberEnv("RETENTION_TICKET_IMAGE_DAYS", 30)));
}

export function getPortalArtifactRetentionDays() {
  return Math.max(1, Math.floor(getNumberEnv("RETENTION_PORTAL_ARTIFACT_DAYS", 7)));
}

export function getBillingCommandRetentionDays() {
  return Math.max(1, Math.floor(getNumberEnv("RETENTION_BILLING_COMMAND_DAYS", 30)));
}

export function getInactiveTemplateCandidateRetentionDays() {
  return Math.max(1, Math.floor(getNumberEnv("RETENTION_INACTIVE_TEMPLATE_DAYS", 45)));
}

export function getMaintenanceBatchSize() {
  return Math.max(1, Math.min(400, Math.floor(getNumberEnv("MAINTENANCE_BATCH_SIZE", 100))));
}

export function isAbandonedJobPurgeEnabled() {
  return getEnv("RETENTION_PURGE_ABANDONED_JOBS", "false").toLowerCase() === "true";
}

export function shouldUsePortalFixture() {
  return getCliOption("portal-fixture") === "true" || getEnv("PORTAL_USE_FIXTURE", "false") === "true";
}

export function getFirestoreRoot() {
  return {
    collection: getEnv("FIRESTORE_ROOT_COLLECTION", "EasySat"),
    document: getEnv("FIRESTORE_ROOT_DOCUMENT", "app"),
    workerUid: getEnv("FIRESTORE_WORKER_UID"),
  };
}

function getNumberEnv(name, fallback) {
  const value = Number(getEnv(name, fallback));
  return Number.isFinite(value) ? value : fallback;
}

function normalizeBucketName(value) {
  return String(value ?? "")
    .replace(/^gs:\/\//, "")
    .trim();
}
