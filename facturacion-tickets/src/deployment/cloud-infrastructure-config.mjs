import { isIP } from "node:net";

const PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const REGION_PATTERN = /^[a-z]+(?:-[a-z0-9]+)+[0-9]$/;
const RESOURCE_NAME_PATTERN = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SERVICE_ACCOUNT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const SECRET_NAME_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

export const REQUIRED_STAGING_APIS = Object.freeze([
  "aiplatform.googleapis.com",
  "artifactregistry.googleapis.com",
  "compute.googleapis.com",
  "firestore.googleapis.com",
  "iam.googleapis.com",
  "redis.googleapis.com",
  "run.googleapis.com",
  "secretmanager.googleapis.com",
  "serviceusage.googleapis.com",
  "storage.googleapis.com",
  "vision.googleapis.com",
]);

export function normalizeInfrastructureConfig(raw) {
  const projectId = String(raw?.projectId ?? "").trim();
  const runtimeServiceAccountId = String(raw?.runtimeServiceAccountId ?? "").trim();

  return {
    projectId,
    region: String(raw?.region ?? "").trim(),
    network: String(raw?.network ?? "").trim(),
    subnetwork: String(raw?.subnetwork ?? "").trim(),
    subnetCidr: String(raw?.subnetCidr ?? "").trim(),
    redis: {
      name: String(raw?.redis?.name ?? "").trim(),
      tier: String(raw?.redis?.tier ?? "basic").trim().toLowerCase(),
      memorySizeGb: Number(raw?.redis?.memorySizeGb ?? 1),
      version: String(raw?.redis?.version ?? "redis_7_2").trim().toLowerCase(),
      maxmemoryPolicy: String(raw?.redis?.maxmemoryPolicy ?? "").trim().toLowerCase(),
    },
    artifactRepository: String(raw?.artifactRepository ?? "").trim(),
    runtimeServiceAccountId,
    runtimeServiceAccountEmail: String(
      raw?.runtimeServiceAccountEmail ??
        `${runtimeServiceAccountId}@${projectId}.iam.gserviceaccount.com`,
    ).trim(),
    geminiBackend: String(raw?.geminiBackend ?? "developer").trim().toLowerCase(),
    geminiVertexLocation: String(raw?.geminiVertexLocation ?? "global").trim(),
    geminiSecretName: String(raw?.geminiSecretName ?? "").trim(),
    apiServiceTokenSecretName: String(raw?.apiServiceTokenSecretName ?? "").trim(),
    firebaseStorageBucket: String(raw?.firebaseStorageBucket ?? "").trim(),
    allowedOrigins: (raw?.allowedOrigins ?? []).map((value) => String(value).trim()),
  };
}

export function validateInfrastructureConfig(rawConfig) {
  const config = normalizeInfrastructureConfig(rawConfig);

  if (!PROJECT_PATTERN.test(config.projectId)) {
    throw new Error(`Invalid projectId: ${config.projectId}`);
  }
  if (!REGION_PATTERN.test(config.region)) {
    throw new Error(`Invalid region: ${config.region}`);
  }

  for (const [label, value] of [
    ["network", config.network],
    ["subnetwork", config.subnetwork],
    ["redis.name", config.redis.name],
    ["artifactRepository", config.artifactRepository],
  ]) {
    if (!RESOURCE_NAME_PATTERN.test(value)) {
      throw new Error(`Invalid ${label}: ${value}`);
    }
  }

  validatePrivateIpv4Cidr(config.subnetCidr);

  if (!SERVICE_ACCOUNT_ID_PATTERN.test(config.runtimeServiceAccountId)) {
    throw new Error(`Invalid runtimeServiceAccountId: ${config.runtimeServiceAccountId}`);
  }
  const expectedServiceAccountEmail =
    `${config.runtimeServiceAccountId}@${config.projectId}.iam.gserviceaccount.com`;
  if (config.runtimeServiceAccountEmail !== expectedServiceAccountEmail) {
    throw new Error(
      `runtimeServiceAccountEmail must be ${expectedServiceAccountEmail}`,
    );
  }

  if (!["vertex", "developer"].includes(config.geminiBackend)) {
    throw new Error("geminiBackend must be vertex or developer");
  }
  if (!/^[a-z0-9-]+$/i.test(config.geminiVertexLocation)) {
    throw new Error("geminiVertexLocation must be a valid Google Cloud location");
  }
  if (config.geminiBackend === "developer" && !SECRET_NAME_PATTERN.test(config.geminiSecretName)) {
    throw new Error(`Invalid geminiSecretName: ${config.geminiSecretName}`);
  }
  if (config.apiServiceTokenSecretName && !SECRET_NAME_PATTERN.test(config.apiServiceTokenSecretName)) {
    throw new Error(`Invalid apiServiceTokenSecretName: ${config.apiServiceTokenSecretName}`);
  }
  if (!/^[a-z0-9.-]+\.firebasestorage\.app$/i.test(config.firebaseStorageBucket)) {
    throw new Error("firebaseStorageBucket must be a firebasestorage.app bucket name");
  }

  if (!["basic", "standard_ha"].includes(config.redis.tier)) {
    throw new Error("redis.tier must be basic or standard_ha");
  }
  if (!Number.isInteger(config.redis.memorySizeGb) || config.redis.memorySizeGb < 1) {
    throw new Error("redis.memorySizeGb must be an integer >= 1");
  }
  if (!/^redis_[0-9]+_[0-9]+$/.test(config.redis.version)) {
    throw new Error(`Invalid redis.version: ${config.redis.version}`);
  }
  if (config.redis.maxmemoryPolicy !== "noeviction") {
    throw new Error("redis.maxmemoryPolicy must be noeviction for BullMQ");
  }

  if (!Array.isArray(config.allowedOrigins) || config.allowedOrigins.length === 0) {
    throw new Error("allowedOrigins must contain at least one HTTPS origin");
  }
  for (const origin of config.allowedOrigins) {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" || parsed.origin !== origin) {
      throw new Error(`Invalid allowed origin: ${origin}`);
    }
  }

  return config;
}

export function buildInfrastructurePlan(rawConfig) {
  const config = validateInfrastructureConfig(rawConfig);
  return {
    mode: "plan_only",
    projectId: config.projectId,
    region: config.region,
    requiredApis: [...REQUIRED_STAGING_APIS],
    resources: {
      network: config.network,
      subnetwork: {
        name: config.subnetwork,
        cidr: config.subnetCidr,
      },
      redis: { ...config.redis },
      artifactRepository: config.artifactRepository,
      runtimeServiceAccount: config.runtimeServiceAccountEmail,
      gemini: {
        backend: config.geminiBackend,
        location: config.geminiVertexLocation,
        runtimeRole: config.geminiBackend === "vertex" ? "roles/aiplatform.user" : null,
        secret: config.geminiBackend === "developer" ? config.geminiSecretName : null,
      },
      apiServiceToken: {
        secret: config.apiServiceTokenSecretName || null,
        runtimeRole: config.apiServiceTokenSecretName ? "roles/secretmanager.secretAccessor" : null,
      },
    },
    runtimeInputsPending: [
      "redis_private_ip",
      "api_image_sha256",
      "ocr_image_sha256",
      "browser_image_sha256",
      ...(config.geminiBackend === "developer" ? ["gemini_secret_numeric_version"] : []),
      ...(config.apiServiceTokenSecretName ? ["api_service_token_hash_secret_numeric_version"] : []),
    ],
    billableWhenApplied: [
      "memorystore_redis",
      "cloud_run_runtime",
      "artifact_storage",
      ...(config.geminiBackend === "vertex" ? ["vertex_ai_model_usage"] : []),
    ],
  };
}

function validatePrivateIpv4Cidr(value) {
  const [address, prefixText, ...extra] = value.split("/");
  const prefix = Number(prefixText);
  if (extra.length > 0 || isIP(address) !== 4 || !Number.isInteger(prefix)) {
    throw new Error(`Invalid subnetCidr: ${value}`);
  }
  if (prefix < 16 || prefix > 28) {
    throw new Error("subnetCidr prefix must be between /16 and /28");
  }

  const octets = address.split(".").map(Number);
  const privateAddress =
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
  if (!privateAddress) {
    throw new Error("subnetCidr must use an RFC1918 private IPv4 range");
  }

  const numericAddress = octets.reduce(
    (result, octet) => ((result << 8) | octet) >>> 0,
    0,
  );
  const hostBits = 32 - prefix;
  const hostMask = hostBits === 32 ? 0xffffffff : (2 ** hostBits - 1) >>> 0;
  if ((numericAddress & hostMask) !== 0) {
    throw new Error("subnetCidr address must be aligned to its prefix");
  }
}
