const MANAGED_LABELS = Object.freeze({
  easysat_component: "billing",
  easysat_managed: "true",
});

export function buildBillingMonitoringPolicies({ notificationChannels = [] } = {}) {
  const channels = normalizeNotificationChannels(notificationChannels);

  return [
    buildLogAlertPolicy({
      key: "queue_critical",
      displayName: "EasySat Billing: queue critical",
      severity: "CRITICAL",
      filter: [
        'jsonPayload.meta.event="billing_queue_alert"',
        'jsonPayload.meta.status="critical"',
      ].join("\n"),
      conditionDisplayName: "Billing queue emitted a critical health signal",
      notificationChannels: channels,
      notificationPeriod: "300s",
      documentation: [
        "A Billing queue, worker, or Redis dependency reported a critical condition.",
        "",
        "1. Inspect the monitor worker logs and `npm run queue:health -- --strict`.",
        "2. Confirm OCR, portal/B3, and Capa C workers are running.",
        "3. Check Redis reachability before restarting workers.",
      ].join("\n"),
    }),
    buildLogAlertPolicy({
      key: "b3_usage_critical",
      displayName: "EasySat Billing: B3 usage critical",
      severity: "WARNING",
      filter: [
        'jsonPayload.meta.event="b3_llm_usage"',
        'jsonPayload.meta.severity="critical"',
      ].join("\n"),
      conditionDisplayName: "B3 run crossed the critical usage threshold",
      notificationChannels: channels,
      notificationPeriod: "3600s",
      documentation: [
        "One B3 browser-use run exceeded the configured token or estimated-cost threshold.",
        "",
        "1. Inspect the B3 event for model, attempt, token count, and pricing source.",
        "2. Check whether a portal loop or repeated retry caused the usage spike.",
        "3. Tune thresholds only after comparing the estimate with the provider billing export.",
      ].join("\n"),
    }),
  ];
}

export function normalizeNotificationChannels(channels) {
  const values = Array.isArray(channels) ? channels : String(channels ?? "").split(",");
  const unique = new Set();

  for (const value of values) {
    const channel = String(value ?? "").trim();
    if (!channel) continue;
    if (!/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/notificationChannels\/[A-Za-z0-9_-]+$/.test(channel)) {
      throw new Error(`Invalid Cloud Monitoring notification channel: ${channel}`);
    }
    unique.add(channel);
  }

  return [...unique].sort();
}

function buildLogAlertPolicy({
  key,
  displayName,
  severity,
  filter,
  conditionDisplayName,
  notificationChannels,
  notificationPeriod,
  documentation,
}) {
  return {
    key,
    policy: {
      displayName,
      documentation: {
        content: documentation,
        mimeType: "text/markdown",
        subject: displayName,
      },
      userLabels: {
        ...MANAGED_LABELS,
        easysat_policy: key,
      },
      conditions: [
        {
          displayName: conditionDisplayName,
          conditionMatchedLog: { filter },
        },
      ],
      combiner: "OR",
      enabled: true,
      notificationChannels,
      alertStrategy: {
        notificationRateLimit: { period: notificationPeriod },
        notificationPrompts: ["OPENED"],
        autoClose: "86400s",
      },
      severity,
    },
  };
}
