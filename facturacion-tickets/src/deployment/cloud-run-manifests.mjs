const IMAGE_DIGEST_PATTERN = /^[a-z0-9.-]+(?:\:[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/i;
const SERVICE_ACCOUNT_PATTERN = /^[a-z0-9._-]+@[a-z0-9.-]+\.iam\.gserviceaccount\.com$/i;
const NAME_PATTERN = /^[a-z]([a-z0-9-]{0,47}[a-z0-9])?$/;
const PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const REGION_PATTERN = /^[a-z]+(?:-[a-z0-9]+)+[0-9]$/;
const SECRET_NAME_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function generateCloudRunManifests(rawConfig) {
  const config = normalizeCloudRunConfig(rawConfig);
  validateCloudRunConfig(config);

  const names = {
    api: `${config.namePrefix}-api`,
    ocr: `${config.namePrefix}-ocr`,
    portal: `${config.namePrefix}-portal`,
    capaC: `${config.namePrefix}-capa-c`,
    monitor: `${config.namePrefix}-monitor`,
  };

  for (const name of Object.values(names)) {
    if (!NAME_PATTERN.test(name)) {
      throw new Error(`Invalid Cloud Run resource name: ${name}`);
    }
  }

  const commonWorkerEnv = {
    FIREBASE_PROJECT_ID: config.projectId,
    FIREBASE_STORAGE_BUCKET: config.firebaseStorageBucket,
    FIRESTORE_ROOT_COLLECTION: config.firestoreRootCollection,
    FIRESTORE_ROOT_DOCUMENT: config.firestoreRootDocument,
    BILLING_JOB_STORE: "firestore",
    CFDI_STORAGE_MODE: "firebase",
    PORTAL_KNOWLEDGE_STORE: "firestore",
    REDIS_URL: `redis://${config.redisHost}:${config.redisPort}`,
    BILLING_DISPATCH_MODE: "hybrid",
    BILLING_QUEUE_PREFIX: config.queuePrefix,
    BILLING_RELEASE_ID: config.releaseId,
    BILLING_QUEUE_FALLBACK_POLL_MS: "30000",
    PORTAL_RATE_LIMIT_BACKEND: "redis",
    PORTAL_RATE_LIMIT_REDIS_REQUIRED: "true",
    PORTAL_RATE_LIMIT_NAMESPACE: `${config.queuePrefix}:portal`,
    FIRESTORE_ENABLE_COLLECTION_GROUP: "true",
    HEADLESS: "true",
    GEMINI_BACKEND: config.geminiBackend,
    AI_GEMINI_MODEL: config.geminiModel,
    ...(config.geminiBackend === "vertex"
      ? {
          GEMINI_VERTEX_PROJECT: config.projectId,
          GEMINI_VERTEX_LOCATION: config.geminiVertexLocation,
        }
      : {}),
  };
  const geminiSecretEnv = config.geminiBackend === "developer"
    ? [{
        name: "GEMINI_API_KEY",
        secret: config.geminiSecret.name,
        version: config.geminiSecret.version,
      }]
    : [];

  const manifests = {
    "api-service.yaml": renderApiService({ config, name: names.api }),
    "ocr-worker-pool.yaml": renderWorkerPool({
      config,
      name: names.ocr,
      image: config.images.ocr,
      command: ["node"],
      args: [
        "src/index.mjs",
        "--watch",
        "--store=firestore",
        "--worker-lane=ocr",
        `--worker-concurrency=${config.concurrency.ocr}`,
      ],
      env: {
        ...commonWorkerEnv,
        OCR_ENGINE: "google_vision",
        OCR_GEMINI_VISION_ENABLED: "true",
        OCR_GEMINI_VISION_MODEL: config.geminiModel,
        OCR_AUTONOMOUS_MAX_CANDIDATE_SETS: "4",
        WORKER_ID: `${names.ocr}-1`,
        WORKER_LANE: "ocr",
        WORKER_CONCURRENCY: String(config.concurrency.ocr),
      },
      secretEnv: geminiSecretEnv,
      cpu: "1",
      memory: "1Gi",
    }),
    "portal-worker-pool.yaml": renderWorkerPool({
      config,
      name: names.portal,
      image: config.images.browser,
      command: ["node"],
      args: [
        "src/index.mjs",
        "--watch",
        "--store=firestore",
        "--worker-lane=portal",
        `--worker-concurrency=${config.concurrency.portal}`,
      ],
      env: {
        ...commonWorkerEnv,
        PORTAL_RUNNER_MODE: "playwright",
        BILLING_AUTOPILOT_MODE: "safe",
        BILLING_AUTOPILOT_FINAL_SUBMIT: "true",
        WORKER_ID: `${names.portal}-1`,
        WORKER_LANE: "portal",
        WORKER_CONCURRENCY: String(config.concurrency.portal),
        B3_BROWSER_USE_ENABLED: "true",
        B3_BROWSER_USE_PROVIDER: "google",
        B3_BROWSER_USE_MODEL: config.geminiModel,
        B3_BROWSER_USE_DISABLE_DEV_SHM_USAGE: "true",
        B3_BROWSER_USE_CHROMIUM_SANDBOX: "false",
        B3_BROWSER_USE_DEFAULT_EXTENSIONS: "false",
        B3_BROWSER_USE_CALCULATE_COST: "false",
        B3_AUTO_COMPILE_TO_A: "true",
        B3_AUTO_REPLAY_A: "true",
      },
      secretEnv: geminiSecretEnv,
      cpu: "2",
      memory: "4Gi",
    }),
    "capa-c-worker-pool.yaml": renderWorkerPool({
      config,
      name: names.capaC,
      image: config.images.browser,
      command: ["node"],
      args: [
        "src/index.mjs",
        "--watch",
        "--store=firestore",
        "--worker-lane=capa_c",
        `--worker-concurrency=${config.concurrency.capaC}`,
      ],
      env: {
        ...commonWorkerEnv,
        PORTAL_RUNNER_MODE: "playwright",
        WORKER_ID: `${names.capaC}-1`,
        WORKER_LANE: "capa_c",
        WORKER_CONCURRENCY: String(config.concurrency.capaC),
        CAPA_C_HANDOFF_MODE: "flutter_webview",
        CAPA_C_HEADLESS: "true",
        CAPA_C_KEEP_BROWSER_OPEN: "false",
      },
      cpu: "1",
      memory: "2Gi",
    }),
    "queue-monitor-worker-pool.yaml": renderWorkerPool({
      config,
      name: names.monitor,
      image: config.images.api,
      command: ["node"],
      args: ["src/scripts/monitor-billing-queues.mjs", "--watch"],
      env: {
        REDIS_URL: `redis://${config.redisHost}:${config.redisPort}`,
        BILLING_QUEUE_PREFIX: config.queuePrefix,
        BILLING_MONITOR_REQUIRE_WORKERS: "true",
        BILLING_MONITOR_INTERVAL_MS: "30000",
        BILLING_MONITOR_STARTUP_GRACE_MS: "60000",
        BILLING_MONITOR_ALERT_COOLDOWN_MS: "300000",
      },
      cpu: "1",
      memory: "512Mi",
    }),
  };

  return {
    config,
    names,
    manifests,
    scaling: {
      [names.ocr]: config.instances.ocr,
      [names.portal]: config.instances.portal,
      [names.capaC]: config.instances.capaC,
      [names.monitor]: config.instances.monitor,
    },
  };
}

export function validateCloudRunConfig(config) {
  const requiredStrings = [
    ["projectId", config.projectId],
    ["region", config.region],
    ["network", config.network],
    ["subnetwork", config.subnetwork],
    ["redisHost", config.redisHost],
    ["runtimeServiceAccount", config.runtimeServiceAccount],
    ["releaseId", config.releaseId],
    ["geminiBackend", config.geminiBackend],
    ["geminiVertexLocation", config.geminiVertexLocation],
  ];

  for (const [name, value] of requiredStrings) {
    const normalized = String(value ?? "").trim();
    if (!normalized) {
      throw new Error(`Missing Cloud Run setting: ${name}`);
    }
    if (/REPLACE_|__SET|<[^>]+>/i.test(normalized)) {
      throw new Error(`Cloud Run setting still contains a placeholder: ${name}`);
    }
  }

  if (!PROJECT_PATTERN.test(config.projectId)) {
    throw new Error(`Invalid projectId: ${config.projectId}`);
  }

  if (!REGION_PATTERN.test(config.region)) {
    throw new Error(`Invalid region: ${config.region}`);
  }

  if (!NAME_PATTERN.test(config.namePrefix)) {
    throw new Error(`Invalid namePrefix: ${config.namePrefix}`);
  }

  if (!SERVICE_ACCOUNT_PATTERN.test(config.runtimeServiceAccount)) {
    throw new Error("runtimeServiceAccount must be a Google service account email");
  }

  if (!["vertex", "developer"].includes(config.geminiBackend)) {
    throw new Error("geminiBackend must be vertex or developer");
  }

  if (!/^[a-z0-9-]+$/i.test(config.geminiVertexLocation)) {
    throw new Error("geminiVertexLocation must be a valid Google Cloud location");
  }

  if (config.geminiBackend === "developer") {
    if (!config.geminiSecret.name || !config.geminiSecret.version) {
      throw new Error("geminiSecret is required when geminiBackend is developer");
    }

    if (!/^\d+$/.test(config.geminiSecret.version)) {
      throw new Error("geminiSecret.version must be a pinned numeric Secret Manager version");
    }
  }

  if (!Number.isInteger(config.redisPort) || config.redisPort < 1 || config.redisPort > 65535) {
    throw new Error("redisPort must be an integer between 1 and 65535");
  }

  for (const [name, image] of Object.entries(config.images)) {
    if (!IMAGE_DIGEST_PATTERN.test(image)) {
      throw new Error(`${name} image must use an immutable @sha256 digest`);
    }
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

  for (const [name, count] of Object.entries(config.instances)) {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`instances.${name} must be an integer >= 1`);
    }
  }

  for (const [name, count] of Object.entries(config.concurrency)) {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`concurrency.${name} must be an integer >= 1`);
    }
  }

  if (
    !Number.isInteger(config.apiMinInstances) ||
    !Number.isInteger(config.apiMaxInstances) ||
    config.apiMinInstances < 0 ||
    config.apiMaxInstances < config.apiMinInstances
  ) {
    throw new Error("API instance bounds are invalid");
  }

  if (typeof config.apiPublicAccess !== "boolean") {
    throw new Error("apiPublicAccess must be a boolean");
  }

  const serviceTokenSecret = config.apiServiceTokenSecret;
  const hasServiceTokenSecret = Boolean(serviceTokenSecret.name || serviceTokenSecret.version);
  if (hasServiceTokenSecret) {
    if (!SECRET_NAME_PATTERN.test(serviceTokenSecret.name)) {
      throw new Error("apiServiceTokenSecret.name must be a valid Secret Manager name");
    }
    if (!/^\d+$/.test(serviceTokenSecret.version)) {
      throw new Error("apiServiceTokenSecret.version must be a pinned numeric Secret Manager version");
    }
    if (!CLIENT_ID_PATTERN.test(config.apiServiceTokenClientId)) {
      throw new Error("apiServiceTokenClientId has an invalid shape");
    }
  }

  return true;
}

function normalizeCloudRunConfig(raw) {
  const projectId = String(raw?.projectId ?? "").trim();
  return {
    projectId,
    region: String(raw?.region ?? "").trim(),
    namePrefix: String(raw?.namePrefix ?? "easysat-billing-stg").trim(),
    network: String(raw?.network ?? "").trim(),
    subnetwork: String(raw?.subnetwork ?? "").trim(),
    redisHost: String(raw?.redisHost ?? "").trim(),
    redisPort: Number(raw?.redisPort ?? 6379),
    runtimeServiceAccount: String(raw?.runtimeServiceAccount ?? "").trim(),
    firebaseStorageBucket: String(
      raw?.firebaseStorageBucket ?? `${projectId}.firebasestorage.app`,
    ).trim(),
    firestoreRootCollection: String(raw?.firestoreRootCollection ?? "EasySat").trim(),
    firestoreRootDocument: String(raw?.firestoreRootDocument ?? "app").trim(),
    queuePrefix: String(raw?.queuePrefix ?? "easysat:billing:staging").trim(),
    releaseId: String(raw?.releaseId ?? "").trim(),
    geminiModel: String(raw?.geminiModel ?? "gemini-3.1-flash-lite").trim(),
    geminiBackend: String(raw?.geminiBackend ?? "developer").trim().toLowerCase(),
    geminiVertexLocation: String(raw?.geminiVertexLocation ?? "global").trim(),
    geminiSecret: {
      name: String(raw?.geminiSecret?.name ?? "").trim(),
      version: String(raw?.geminiSecret?.version ?? "").trim(),
    },
    allowedOrigins: (raw?.allowedOrigins ?? []).map((value) => String(value).trim()),
    images: {
      api: String(raw?.images?.api ?? "").trim(),
      ocr: String(raw?.images?.ocr ?? "").trim(),
      browser: String(raw?.images?.browser ?? "").trim(),
    },
    instances: {
      ocr: Number(raw?.instances?.ocr ?? 1),
      portal: Number(raw?.instances?.portal ?? 1),
      capaC: Number(raw?.instances?.capaC ?? 1),
      monitor: Number(raw?.instances?.monitor ?? 1),
    },
    concurrency: {
      ocr: Number(raw?.concurrency?.ocr ?? 4),
      portal: Number(raw?.concurrency?.portal ?? 1),
      capaC: Number(raw?.concurrency?.capaC ?? 2),
    },
    apiMinInstances: Number(raw?.apiMinInstances ?? 0),
    apiMaxInstances: Number(raw?.apiMaxInstances ?? 10),
    apiPublicAccess: raw?.apiPublicAccess === true,
    apiServiceTokenClientId: String(raw?.apiServiceTokenClientId ?? "external_client").trim() || "external_client",
    apiServiceTokenSecret: {
      name: String(raw?.apiServiceTokenSecret?.name ?? "").trim(),
      version: String(raw?.apiServiceTokenSecret?.version ?? "").trim(),
    },
  };
}

function renderApiService({ config, name }) {
  const env = {
    FIREBASE_PROJECT_ID: config.projectId,
    FIREBASE_STORAGE_BUCKET: config.firebaseStorageBucket,
    FIRESTORE_ROOT_COLLECTION: config.firestoreRootCollection,
    FIRESTORE_ROOT_DOCUMENT: config.firestoreRootDocument,
    REDIS_URL: `redis://${config.redisHost}:${config.redisPort}`,
    BILLING_DISPATCH_MODE: "hybrid",
    BILLING_QUEUE_PREFIX: config.queuePrefix,
    BILLING_RELEASE_ID: config.releaseId,
    BILLING_API_ALLOWED_ORIGINS: config.allowedOrigins.join(","),
    BILLING_API_TICKET_LIMIT_BYTES: String(10 * 1024 * 1024),
  };
  if (config.apiServiceTokenSecret.name) {
    env.BILLING_API_SERVICE_TOKEN_CLIENT_ID = config.apiServiceTokenClientId;
  }
  const secretEnv = config.apiServiceTokenSecret.name
    ? [{
        name: "BILLING_API_SERVICE_TOKEN_HASH",
        secret: config.apiServiceTokenSecret.name,
        version: config.apiServiceTokenSecret.version,
      }]
    : [];

  return `apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: ${yamlString(name)}
  labels:
    cloud.googleapis.com/location: ${yamlString(config.region)}
  annotations:
    run.googleapis.com/invoker-iam-disabled: ${yamlString(config.apiPublicAccess)}
    run.googleapis.com/default-url-disabled: ${yamlString(false)}
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/minScale: ${yamlString(config.apiMinInstances)}
        autoscaling.knative.dev/maxScale: ${yamlString(config.apiMaxInstances)}
        run.googleapis.com/execution-environment: ${yamlString("gen2")}
        run.googleapis.com/network-interfaces: ${yamlString(networkInterfaces(config))}
        run.googleapis.com/vpc-access-egress: ${yamlString("private-ranges-only")}
    spec:
      serviceAccountName: ${yamlString(config.runtimeServiceAccount)}
      containerConcurrency: 40
      timeoutSeconds: 60
      containers:
      - name: ${yamlString("api")}
        image: ${yamlString(config.images.api)}
        ports:
        - name: http1
          containerPort: 8080
${renderEnv(env, 8, secretEnv)}
        resources:
          limits:
            cpu: ${yamlString("1")}
            memory: ${yamlString("512Mi")}
`;
}

function renderWorkerPool({
  config,
  name,
  image,
  command,
  args,
  env,
  secretEnv = [],
  cpu,
  memory,
}) {
  return `apiVersion: run.googleapis.com/v1
kind: WorkerPool
metadata:
  name: ${yamlString(name)}
  labels:
    cloud.googleapis.com/location: ${yamlString(config.region)}
spec:
  template:
    metadata:
      annotations:
        run.googleapis.com/network-interfaces: ${yamlString(networkInterfaces(config))}
        run.googleapis.com/vpc-access-egress: ${yamlString("private-ranges-only")}
    spec:
      serviceAccountName: ${yamlString(config.runtimeServiceAccount)}
      containers:
      - name: ${yamlString("worker")}
        image: ${yamlString(image)}
${renderStringList("command", command, 8)}
${renderStringList("args", args, 8)}
${renderEnv(env, 8, secretEnv)}
        resources:
          limits:
            cpu: ${yamlString(cpu)}
            memory: ${yamlString(memory)}
`;
}

function renderEnv(env, indent, secrets = []) {
  const padding = " ".repeat(indent);
  const lines = [`${padding}env:`];
  for (const [name, value] of Object.entries(env)) {
    lines.push(`${padding}- name: ${yamlString(name)}`);
    lines.push(`${padding}  value: ${yamlString(value)}`);
  }
  for (const secret of secrets) {
    lines.push(`${padding}- name: ${yamlString(secret.name)}`);
    lines.push(`${padding}  valueFrom:`);
    lines.push(`${padding}    secretKeyRef:`);
    lines.push(`${padding}      name: ${yamlString(secret.secret)}`);
    lines.push(`${padding}      key: ${yamlString(secret.version)}`);
  }
  return lines.join("\n");
}

function renderStringList(name, values, indent) {
  const padding = " ".repeat(indent);
  return [
    `${padding}${name}:`,
    ...values.map((value) => `${padding}- ${yamlString(value)}`),
  ].join("\n");
}

function networkInterfaces(config) {
  return JSON.stringify([
    {
      network: config.network,
      subnetwork: config.subnetwork,
    },
  ]);
}

function yamlString(value) {
  return JSON.stringify(String(value));
}
