import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import {
  getFirebaseAuth,
  getFirebaseDb,
  getFirebaseStorageBucket,
} from "../config/firebase.mjs";

const expectedProjectId = "appsat-dev";
const ticketPath = resolve(getRequiredArg("--ticket"));
const apiBaseUrl = normalizeApiBaseUrl(getRequiredEnv("BILLING_API_BASE_URL"));
const firebaseWebApiKey = getRequiredEnv("FIREBASE_WEB_API_KEY");
const projectId = getRequiredEnv("FIREBASE_PROJECT_ID");
const cleanupRequested = process.argv.includes("--cleanup");
const timeoutMs = getPositiveIntegerArg("--timeout-ms", 180_000);
const safeCleanupStatuses = new Set([
  "ocr_review_required",
  "needs_user_action",
  "failed",
  "cancelled",
  "expired",
]);

if (!process.argv.includes("--confirm-staging")) {
  throw new Error("Pass --confirm-staging to run the live OCR smoke test.");
}
if (projectId !== expectedProjectId) {
  throw new Error(`OCR smoke test is restricted to ${expectedProjectId}.`);
}
if (!apiBaseUrl.hostname.startsWith("appsat-billing-stg-api-")) {
  throw new Error("BILLING_API_BASE_URL must point to the AppSat staging API.");
}

const ticketStats = await stat(ticketPath);
if (!ticketStats.isFile() || ticketStats.size < 1 || ticketStats.size > 10 * 1024 * 1024) {
  throw new Error("Ticket image must be a non-empty file up to 10 MiB.");
}

const probeId = `${Date.now()}_${randomUUID().slice(0, 8)}`;
const uid = `billing_stg_ocr_probe_${probeId}`;
const objectPath = `billing-lab/tickets/${uid}/ocr-smoke-${probeId}${extname(ticketPath).toLowerCase() || ".jpg"}`;
const downloadToken = randomUUID();
const auth = getFirebaseAuth();
const db = getFirebaseDb();
const bucket = getFirebaseStorageBucket();
let jobId = null;
let lastStatus = null;
let cleaned = false;
const startedAt = Date.now();

try {
  await bucket.upload(ticketPath, {
    destination: objectPath,
    resumable: false,
    metadata: {
      contentType: getImageContentType(ticketPath),
      metadata: { firebaseStorageDownloadTokens: downloadToken },
    },
  });

  const customToken = await auth.createCustomToken(uid);
  const idToken = await exchangeCustomToken(customToken, firebaseWebApiKey);
  const ticketFileUrl = buildFirebaseDownloadUrl(bucket.name, objectPath, downloadToken);
  const created = await apiRequest("/v1/billing/jobs", idToken, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `ocr-smoke-${probeId}`,
    },
    body: JSON.stringify({
      ticketFileUrl,
      taxProfileId: "staging_ocr_smoke",
      taxProfile: buildSmokeTaxProfile(),
    }),
  });
  jobId = created.data?.id ?? null;
  if (!jobId) throw new Error("Billing API did not return a job id.");

  const deadline = Date.now() + timeoutMs;
  let job = created.data;
  while (Date.now() < deadline) {
    lastStatus = job?.status ?? null;
    if (isExpectedOcrReview(job)) break;
    if (["failed", "cancelled", "expired"].includes(lastStatus)) {
      throw new Error(`OCR smoke test stopped in unexpected status: ${lastStatus}.`);
    }
    if (lastStatus === "needs_user_action") {
      throw new Error(
        `OCR smoke test stopped for unexpected user action: ${sanitizeDiagnostic(job?.userAction?.reason ?? "unknown")}.`,
      );
    }
    await sleep(Math.max(1_000, Math.min(5_000, Number(job?.pollAfterMs) || 2_000)));
    job = (await apiRequest(`/v1/billing/jobs/${jobId}`, idToken)).data;
  }

  if (!isExpectedOcrReview(job)) {
    throw new Error(`OCR smoke test timed out in status: ${lastStatus ?? "unknown"}.`);
  }

  const events = await apiRequest(`/v1/billing/jobs/${jobId}/events?limit=20`, idToken);
  const eventTypes = new Set((events.data ?? []).map((event) => event.type));
  if (!eventTypes.has("ocr_started") || !eventTypes.has("ocr_completed")) {
    throw new Error("OCR smoke test did not record the expected OCR events.");
  }
  if (eventTypes.has("portal_discovery_failed")) {
    throw new Error("OCR worker attempted an unsupported browser portal probe.");
  }

  if (cleanupRequested) {
    await cleanupProbe({ auth, db, bucket, uid, objectPath });
    cleaned = true;
  }

  console.log(JSON.stringify({
    ok: true,
    status: lastStatus,
    reason: job.userAction?.reason ?? null,
    elapsedMs: Date.now() - startedAt,
    extracted: {
      rfcEmisor: Boolean(job.ticket?.rfcEmisor),
      fecha: Boolean(job.ticket?.fecha),
      monto: Number.isFinite(job.ticket?.monto),
      folioOrTicket: Boolean(job.ticket?.folio || job.ticket?.ticketId),
    },
    queueEvents: {
      ocrStarted: true,
      ocrCompleted: true,
    },
    cleaned,
  }, null, 2));
} catch (error) {
  let cleanupError = null;
  if (cleanupRequested && (!jobId || safeCleanupStatuses.has(lastStatus))) {
    try {
      await cleanupProbe({ auth, db, bucket, uid, objectPath });
      cleaned = true;
    } catch (probeCleanupError) {
      cleanupError = sanitizeDiagnostic(
        probeCleanupError instanceof Error ? probeCleanupError.message : String(probeCleanupError),
      );
    }
  }
  console.error(JSON.stringify({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
    jobId,
    probeUid: uid,
    lastStatus,
    cleaned,
    ...(cleanupError ? { cleanupError } : {}),
  }, null, 2));
  process.exitCode = 1;
}

async function exchangeCustomToken(customToken, apiKey) {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    },
  );
  const body = await response.json();
  if (!response.ok || !body.idToken) {
    const reason = sanitizeDiagnostic(body.error?.message ?? "unknown");
    throw new Error(`Firebase custom-token exchange failed (${response.status}): ${reason}.`);
  }
  return body.idToken;
}

async function apiRequest(path, idToken, init = {}) {
  const response = await fetch(new URL(path, `${apiBaseUrl.href}/`), {
    ...init,
    headers: {
      Authorization: `Bearer ${idToken}`,
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Billing API ${init.method ?? "GET"} ${path} failed (${response.status}): ${body.error?.code ?? "unknown"}.`);
  }
  return body;
}

async function cleanupProbe({ auth, db, bucket, uid, objectPath }) {
  await bucket.file(objectPath).delete({ ignoreNotFound: true });
  await db.recursiveDelete(db.collection("AppSat").doc("app").collection("users").doc(uid));
  await auth.deleteUser(uid).catch((error) => {
    if (error?.code !== "auth/user-not-found") throw error;
  });
}

function buildFirebaseDownloadUrl(bucketName, path, token) {
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

function buildSmokeTaxProfile() {
  return {
    rfc: "AAA010101AAA",
    legalName: "EMPRESA DEMO SA DE CV",
    email: "billing-smoke@appsat.dev",
    fiscalRegime: "601 - General de Ley Personas Morales",
    fiscalRegimes: ["601 - General de Ley Personas Morales"],
    cfdiUse: "G03 - Gastos en general",
    postalCode: "01000",
    street: "CALLE PRUEBA",
    exteriorNumber: "1",
    interiorNumber: "",
    neighborhood: "CENTRO",
    municipality: "ALVARO OBREGON",
    state: "CIUDAD DE MEXICO",
    country: "MEXICO",
  };
}

function normalizeApiBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("BILLING_API_BASE_URL must use HTTPS.");
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

function getImageContentType(path) {
  switch (extname(path).toLowerCase()) {
    case ".png": return "image/png";
    case ".webp": return "image/webp";
    default: return "image/jpeg";
  }
}

function getRequiredArg(name) {
  const value = process.argv.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value) throw new Error(`Missing ${name}=...`);
  return value;
}

function getPositiveIntegerArg(name, fallback) {
  const raw = process.argv.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function getRequiredEnv(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`Missing environment variable ${name}.`);
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeDiagnostic(value) {
  return String(value)
    .replace(/[^a-z0-9_:\-. ]/gi, "")
    .trim()
    .slice(0, 160) || "unknown";
}

function isExpectedOcrReview(job) {
  return (
    job?.status === "ocr_review_required" ||
    job?.userAction?.reason === "ocr_review_required" ||
    job?.workflowStage === "awaiting_ocr_confirmation"
  );
}
