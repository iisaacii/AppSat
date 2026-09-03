import { randomUUID } from "node:crypto";
import { PNG } from "pngjs";
import {
  getFirebaseAuth,
  getFirebaseDb,
  getFirebaseStorageBucket,
} from "../config/firebase.mjs";
import { getFirestoreRoot } from "../config/env.mjs";

const expectedProjectId = "appsat-dev";
const apiBaseUrl = normalizeApiBaseUrl(requiredEnv("BILLING_API_BASE_URL"));
const firebaseWebApiKey = requiredEnv("FIREBASE_WEB_API_KEY");
const projectId = requiredEnv("FIREBASE_PROJECT_ID");
const timeoutMs = positiveArg("--timeout-ms", 240_000);

if (!process.argv.includes("--confirm-staging")) {
  throw new Error("Pass --confirm-staging to run the live API v2 smoke test.");
}
if (projectId !== expectedProjectId) {
  throw new Error(`API v2 smoke test is restricted to ${expectedProjectId}.`);
}
if (!apiBaseUrl.hostname.startsWith("appsat-billing-stg-api-")) {
  throw new Error("BILLING_API_BASE_URL must point to the AppSat staging API.");
}

const probeId = `${Date.now()}_${randomUUID().slice(0, 8)}`;
const uid = `billing_stg_v2_probe_${probeId}`;
const idempotencyKey = `v2-smoke-${probeId}`;
const auth = getFirebaseAuth();
const db = getFirebaseDb();
const bucket = getFirebaseStorageBucket();
const { collection, document } = getFirestoreRoot();
const userRef = db.collection(collection).doc(document).collection("users").doc(uid);
const storagePrefix = `billing-api/tickets/${uid}/`;
let jobId = null;
let lastStatus = null;
let cleaned = false;
const startedAt = Date.now();

try {
  const idToken = await exchangeCustomToken(
    await auth.createCustomToken(uid),
    firebaseWebApiKey,
  );

  const first = await createAutonomousJob(idToken);
  jobId = first.data?.id ?? null;
  assert(jobId, "Billing API v2 did not return a job id.");
  assert(first.meta?.apiVersion === "billing-http.v2", "API did not identify the v2 contract.");
  assert(first.data?.processingMode === "autonomous", "Job is not in autonomous mode.");
  assert(first.meta?.reused === false, "The first request was unexpectedly reused.");

  const repeated = await createAutonomousJob(idToken);
  assert(repeated.data?.id === jobId, "Idempotent retry created a different job.");
  assert(repeated.meta?.reused === true, "Idempotent retry did not reuse the job.");
  assert(repeated.meta?.uploadReused === true, "Idempotent retry duplicated the ticket upload.");

  const job = await waitForTerminalJob(idToken);
  lastStatus = job.status;
  assert(job.status === "failed", `Blank ticket stopped in unexpected status: ${job.status}.`);
  assert(job.error?.code === "ocr_unresolved", `Expected ocr_unresolved, got ${job.error?.code ?? "none"}.`);
  assert(!job.result?.xmlUrl && !job.result?.pdfUrl, "Blank smoke ticket produced a CFDI unexpectedly.");

  const events = await apiRequest(`/v2/billing/jobs/${jobId}/events?limit=50`, idToken);
  const eventTypes = new Set((events.data ?? []).map((event) => event.type));
  assert(eventTypes.has("created"), "Created event is missing.");
  assert(eventTypes.has("ocr_started"), "OCR worker did not claim the v2 job.");
  assert(eventTypes.has("ocr_completed"), "OCR completion event is missing.");
  const portalAutomationEvents = [
    "ocr_handoff_to_portal",
    "portal_matched",
    "portal_started",
    "portal_retry_variant_started",
    "portal_recovery_started",
    "portal_completed",
  ];
  assert(
    ![...eventTypes].some((type) =>
      String(type).startsWith("b3_") || portalAutomationEvents.includes(String(type))),
    "Blank smoke ticket reached portal automation unexpectedly.",
  );

  await cleanupProbe();
  cleaned = true;
  console.log(JSON.stringify({
    ok: true,
    apiVersion: first.meta.apiVersion,
    processingMode: first.data.processingMode,
    status: job.status,
    reason: job.error.code,
    idempotencyVerified: true,
    queueEvents: { created: true, ocrStarted: true, ocrCompleted: true },
    portalAutomationStarted: false,
    cfdiIssued: false,
    elapsedMs: Date.now() - startedAt,
    cleaned,
  }, null, 2));
} catch (error) {
  if (jobId && !["completed", "resolved", "failed", "cancelled", "expired"].includes(lastStatus)) {
    await userRef.collection("facturaJobs").doc(jobId).set({
      status: "cancelled",
      statusMessage: "Controlled API v2 smoke cleanup",
      updatedAt: new Date(),
    }, { merge: true }).catch(() => {});
  }
  await cleanupProbe().then(() => { cleaned = true; }).catch(() => {});
  console.error(JSON.stringify({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
    lastStatus,
    cleaned,
  }, null, 2));
  process.exitCode = 1;
}

async function createAutonomousJob(idToken) {
  const form = new FormData();
  form.append("ticket", new Blob([buildBlankPng()], { type: "image/png" }), "blank-smoke.png");
  form.append("taxProfile", JSON.stringify(smokeTaxProfile()));
  return apiRequest("/v2/billing/jobs", idToken, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: form,
  });
}

async function waitForTerminalJob(idToken) {
  const deadline = Date.now() + timeoutMs;
  let job = null;
  while (Date.now() < deadline) {
    job = (await apiRequest(`/v2/billing/jobs/${jobId}`, idToken)).data;
    lastStatus = job?.status ?? null;
    if (job?.isTerminal) return job;
    if (job?.needsUserAction) {
      throw new Error(`Blank ticket requested unexpected user action: ${job.userAction?.reason ?? "unknown"}.`);
    }
    await sleep(Math.max(1_000, Math.min(5_000, Number(job?.pollAfterMs) || 2_000)));
  }
  throw new Error(`API v2 smoke timed out in status: ${lastStatus ?? "unknown"}.`);
}

async function apiRequest(path, idToken, init = {}) {
  const response = await fetch(new URL(path, `${apiBaseUrl.href}/`), {
    ...init,
    headers: { Authorization: `Bearer ${idToken}`, ...(init.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Billing API ${init.method ?? "GET"} ${path} failed (${response.status}): ${body.error?.code ?? "unknown"}.`);
  }
  return body;
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
    throw new Error(`Firebase custom-token exchange failed (${response.status}).`);
  }
  return body.idToken;
}

async function cleanupProbe() {
  await bucket.deleteFiles({ prefix: storagePrefix });
  await db.recursiveDelete(userRef);
  await auth.deleteUser(uid).catch((error) => {
    if (error?.code !== "auth/user-not-found") throw error;
  });
}

function buildBlankPng() {
  const png = new PNG({ width: 320, height: 240 });
  png.data.fill(255);
  return PNG.sync.write(png);
}

function smokeTaxProfile() {
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

function positiveArg(name, fallback) {
  const raw = process.argv.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function requiredEnv(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`Missing environment variable ${name}.`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
