import { GoogleAuth } from "google-auth-library";
import {
  buildBillingMonitoringPolicies,
  normalizeNotificationChannels,
} from "../deployment/billing-monitoring-policies.mjs";

const args = parseArgs(process.argv.slice(2));
const apply = args.apply === true;
const projectId = String(
  args.project ?? process.env.FIREBASE_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? "",
).trim();
const notificationChannels = normalizeNotificationChannels(args.notificationChannel ?? []);

if (!projectId) {
  throw new Error("Set --project=<projectId> or FIREBASE_PROJECT_ID before configuring monitoring.");
}

if (apply && notificationChannels.length === 0) {
  throw new Error(
    "Refusing to enable alert policies without --notification-channel=projects/<project>/notificationChannels/<id>.",
  );
}

const desiredPolicies = buildBillingMonitoringPolicies({ notificationChannels });

if (args.listChannels === true) {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await auth.getClient();
  const channels = await withMonitoringAccessGuidance(() => listAllChannels({ client, projectId }));
  console.log(JSON.stringify({
    ok: true,
    mode: "list_channels",
    projectId,
    channels: channels.map((channel) => ({
      name: channel.name ?? null,
      displayName: channel.displayName ?? null,
      type: channel.type ?? null,
      verificationStatus: channel.verificationStatus ?? null,
    })),
  }, null, 2));
  process.exit(0);
}

if (!apply) {
  console.log(JSON.stringify({
    ok: true,
    mode: "plan",
    projectId,
    notificationChannels,
    policies: desiredPolicies.map(({ key, policy }) => ({
      key,
      displayName: policy.displayName,
      logFilter: policy.conditions[0].conditionMatchedLog.filter,
      notificationPeriod: policy.alertStrategy.notificationRateLimit.period,
      hasNotificationChannel: policy.notificationChannels.length > 0,
    })),
    nextStep: "Re-run with --apply and at least one verified --notification-channel.",
  }, null, 2));
  process.exit(0);
}

const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
const client = await auth.getClient();
const existingPolicies = await withMonitoringAccessGuidance(() => listAllPolicies({ client, projectId }));
const results = [];

for (const desired of desiredPolicies) {
  const existing = existingPolicies.find(
    (policy) => policy.userLabels?.easysat_component === "billing"
      && policy.userLabels?.easysat_policy === desired.key,
  );
  const policy = existing ? { ...desired.policy, name: existing.name } : desired.policy;

  if (existing) {
    await withMonitoringAccessGuidance(() => client.request({
      url: `https://monitoring.googleapis.com/v3/${existing.name}?updateMask=${encodeURIComponent([
        "display_name",
        "documentation",
        "user_labels",
        "conditions",
        "combiner",
        "enabled",
        "notification_channels",
        "alert_strategy",
        "severity",
      ].join(","))}`,
      method: "PATCH",
      data: policy,
    }));
    results.push({ key: desired.key, operation: "updated", name: existing.name });
  } else {
    const response = await withMonitoringAccessGuidance(() => client.request({
      url: `https://monitoring.googleapis.com/v3/projects/${projectId}/alertPolicies`,
      method: "POST",
      data: policy,
    }));
    results.push({ key: desired.key, operation: "created", name: response.data?.name ?? null });
  }
}

console.log(JSON.stringify({
  ok: true,
  mode: "apply",
  projectId,
  notificationChannels,
  results,
}, null, 2));

async function listAllPolicies({ client, projectId }) {
  const policies = [];
  let pageToken = null;

  do {
    const url = new URL(`https://monitoring.googleapis.com/v3/projects/${projectId}/alertPolicies`);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await client.request({ url: url.toString(), method: "GET" });
    policies.push(...(response.data?.alertPolicies ?? []));
    pageToken = response.data?.nextPageToken ?? null;
  } while (pageToken);

  return policies;
}

async function listAllChannels({ client, projectId }) {
  const channels = [];
  let pageToken = null;

  do {
    const url = new URL(`https://monitoring.googleapis.com/v3/projects/${projectId}/notificationChannels`);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await client.request({ url: url.toString(), method: "GET" });
    channels.push(...(response.data?.notificationChannels ?? []));
    pageToken = response.data?.nextPageToken ?? null;
  } while (pageToken);

  return channels;
}

async function withMonitoringAccessGuidance(operation) {
  try {
    return await operation();
  } catch (error) {
    const status = Number(error?.response?.status ?? error?.status ?? error?.code);
    if (status === 401 || status === 403) {
      throw new Error(
        "Cloud Monitoring denied this deployment identity. Use a separate deployment/admin identity with Monitoring Editor and notification-channel permissions; do not grant those permissions to the runtime worker service account.",
      );
    }
    throw error;
  }
}

function parseArgs(argv) {
  const parsed = {};

  for (const rawArg of argv) {
    if (rawArg === "--apply") {
      parsed.apply = true;
      continue;
    }
    if (rawArg === "--list-channels") {
      parsed.listChannels = true;
      continue;
    }
    if (!rawArg.startsWith("--")) continue;

    const [rawKey, ...rawValue] = rawArg.slice(2).split("=");
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = rawValue.join("=");

    if (key === "notificationChannel") {
      parsed.notificationChannel ??= [];
      parsed.notificationChannel.push(value);
    } else {
      parsed[key] = value;
    }
  }

  return parsed;
}
