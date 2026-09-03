import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { getFirebaseAuth, getFirebaseDb, getFirebaseStorageBucket } from "../config/firebase.mjs";
import { getFirestoreRoot } from "../config/env.mjs";
import {
  buildPortalKnowledgeDocumentId,
  rememberSharedPortalOutcome,
} from "../portals/portal-knowledge-repository.mjs";

const expectedProjectId = "appsat-dev";
const ticketPath = resolve(requiredArg("--ticket"));
const apiBaseUrl = normalizeApiBaseUrl(requiredEnv("BILLING_API_BASE_URL"));
const firebaseWebApiKey = requiredEnv("FIREBASE_WEB_API_KEY");
const projectId = requiredEnv("FIREBASE_PROJECT_ID");
const timeoutMs = positiveArg("--timeout-ms", 360_000);
const pollMs = positiveArg("--poll-ms", 2_000);

if (!process.argv.includes("--confirm-staging")) {
  throw new Error("Pass --confirm-staging to run the live end-to-end Capa C smoke test.");
}

async function waitForJob(idToken, id, predicate, stageName) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = (await apiRequest(`/v1/billing/jobs/${id}`, idToken)).data;
    lastStatus = job?.status ?? null;
    if (predicate(job)) return job;
    if (["failed", "cancelled", "expired", "completed", "resolved"].includes(lastStatus)) {
      throw new Error(`${stageName} stopped in unexpected status: ${lastStatus}.`);
    }
    if (lastStatus === "needs_user_action" && stageName === "OCR review" && !isOcrReview(job)) {
      throw new Error(`${stageName} stopped for unexpected user action: ${job?.userAction?.reason ?? "unknown"}.`);
    }
    await sleep(Math.max(pollMs, Math.min(5_000, Number(job?.pollAfterMs) || pollMs)));
  }
  throw new Error(`${stageName} timed out in status: ${lastStatus ?? "unknown"}.`);
}

async function sendCommand(idToken, id, key, type, payload) {
  return apiRequest(`/v1/billing/jobs/${id}/commands`, idToken, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ type, payload }),
  });
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

async function cleanupProbe() {
  await bucket.file(objectPath).delete({ ignoreNotFound: true });
  await db.recursiveDelete(userRef);
  await auth.deleteUser(uid).catch((error) => {
    if (error?.code !== "auth/user-not-found") throw error;
  });
}

function selectPortalUrl(job) {
  const candidates = [
    job.portalCandidateUrl,
    job.portalUrl,
    job.extractedData?.portalUrl,
    ...(Array.isArray(job.portalCandidates) ? job.portalCandidates : []),
    ...(Array.isArray(job.ocrCandidates?.portalUrls) ? job.ocrCandidates.portalUrls : []),
  ];
  for (const candidate of candidates) {
    try {
      const url = new URL(clean(candidate));
      if (["http:", "https:"].includes(url.protocol)) return url.href;
    } catch {
      // OCR URL fragments are expected and are ignored.
    }
  }
  return null;
}

function confirmedCorrection(rawJob, publicTicket = {}) {
  const correction = {};
  copy(correction, "rfcEmisor", rawJob.rfcEmisor ?? publicTicket.rfcEmisor, true);
  copy(correction, "rfcReceptor", rawJob.rfcReceptor ?? publicTicket.rfcReceptor, true);
  copy(correction, "folio", rawJob.folio ?? publicTicket.folio);
  copy(correction, "ticketId", rawJob.ticketId ?? rawJob.ocrCandidates?.ticketId ?? publicTicket.ticketId, true);
  copy(correction, "codigoFacturacion", rawJob.codigoFacturacion ?? rawJob.ocrCandidates?.codigoFacturacion);
  copy(correction, "fecha", rawJob.fecha ?? publicTicket.fecha);
  copy(correction, "permisoCre", rawJob.permisoCre ?? rawJob.ocrCandidates?.permisoCre);
  copy(correction, "sucursal", rawJob.sucursal ?? rawJob.ocrCandidates?.sucursal);
  const monto = Number(rawJob.monto ?? publicTicket.monto);
  if (Number.isFinite(monto) && monto >= 0) correction.monto = monto;
  if (!correction.rfcEmisor || !correction.fecha || correction.monto == null) {
    throw new Error("OCR did not extract the minimum fields required for confirmation.");
  }
  return correction;
}

function copy(target, key, value, uppercase = false) {
  let normalized = clean(value);
  if (!normalized) return;
  if (uppercase) normalized = normalized.toUpperCase();
  target[key] = normalized;
}

function smokeTaxProfile() {
  return {
    rfc: "XAXX010101000",
    legalName: "PERSONA CONTRIBUYENTE DEMO",
    email: "pruebas@appsat.dev",
    fiscalRegime: "605 - Sueldos y Salarios e Ingresos Asimilados a Salarios",
    fiscalRegimes: ["605 - Sueldos y Salarios e Ingresos Asimilados a Salarios"],
    cfdiUse: "S01 - Sin efectos fiscales",
    postalCode: "54040",
    street: "CALLE PRUEBA",
    exteriorNumber: "1",
    interiorNumber: "",
    neighborhood: "CENTRO",
    municipality: "TLALNEPANTLA DE BAZ",
    state: "ESTADO DE MEXICO",
    country: "MEXICO",
  };
}

function firebaseDownloadUrl(bucketName, path, token) {
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

function normalizeApiBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("BILLING_API_BASE_URL must use HTTPS.");
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

function imageContentType(path) {
  if (extname(path).toLowerCase() === ".png") return "image/png";
  if (extname(path).toLowerCase() === ".webp") return "image/webp";
  return "image/jpeg";
}

function requiredArg(name) {
  const value = process.argv.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value) throw new Error(`Missing ${name}=...`);
  return value;
}

function positiveArg(name, fallback) {
  const raw = process.argv.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function requiredEnv(name) {
  const value = clean(process.env[name]);
  if (!value) throw new Error(`Missing environment variable ${name}.`);
  return value;
}

function isOcrReview(job) {
  return job?.status === "ocr_review_required" ||
    job?.userAction?.reason === "ocr_review_required" ||
    job?.workflowStage === "awaiting_ocr_confirmation";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function clean(value) {
  return String(value ?? "").trim();
}
if (projectId !== expectedProjectId) {
  throw new Error(`End-to-end smoke test is restricted to ${expectedProjectId}.`);
}
if (!apiBaseUrl.hostname.startsWith("appsat-billing-stg-api-")) {
  throw new Error("BILLING_API_BASE_URL must point to the AppSat staging API.");
}

const ticketStats = await stat(ticketPath);
if (!ticketStats.isFile() || ticketStats.size < 1 || ticketStats.size > 10 * 1024 * 1024) {
  throw new Error("Ticket image must be a non-empty file up to 10 MiB.");
}

process.env.PORTAL_KNOWLEDGE_STORE = "firestore";
const probeId = `${Date.now()}_${randomUUID().slice(0, 8)}`;
const uid = `billing_stg_e2e_c_probe_${probeId}`;
const objectPath = `billing-lab/tickets/${uid}/e2e-c-${probeId}${extname(ticketPath) || ".jpg"}`;
const downloadToken = randomUUID();
const auth = getFirebaseAuth();
const db = getFirebaseDb();
const bucket = getFirebaseStorageBucket();
const { collection, document } = getFirestoreRoot();
const appRef = db.collection(collection).doc(document);
const userRef = appRef.collection("users").doc(uid);
let jobId = null;
let outcomeRef = null;
let previousOutcome = null;
let lastStatus = null;
let cleaned = false;
const startedAt = Date.now();

try {
  await bucket.upload(ticketPath, {
    destination: objectPath,
    resumable: false,
    metadata: {
      contentType: imageContentType(ticketPath),
      metadata: { firebaseStorageDownloadTokens: downloadToken },
    },
  });

  const idToken = await exchangeCustomToken(
    await auth.createCustomToken(uid),
    firebaseWebApiKey,
  );
  const created = await apiRequest("/v1/billing/jobs", idToken, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `e2e-c-${probeId}`,
    },
    body: JSON.stringify({
      ticketFileUrl: firebaseDownloadUrl(bucket.name, objectPath, downloadToken),
      taxProfileId: "staging_e2e_c_smoke",
      taxProfile: smokeTaxProfile(),
    }),
  });
  jobId = created.data?.id;
  if (!jobId) throw new Error("Billing API did not return a job id.");

  const ocrJob = await waitForJob(idToken, jobId, isOcrReview, "OCR review");
  const jobRef = userRef.collection("facturaJobs").doc(jobId);
  const rawSnapshot = await jobRef.get();
  if (!rawSnapshot.exists) throw new Error("OCR job disappeared from Firestore.");
  const rawJob = rawSnapshot.data();
  const rfcEmisor = clean(rawJob.rfcEmisor ?? ocrJob.ticket?.rfcEmisor).toUpperCase();
  const portalUrl = selectPortalUrl(rawJob);
  if (!rfcEmisor) throw new Error("OCR did not extract an issuer RFC.");
  if (!portalUrl) throw new Error("OCR/discovery did not produce a portal URL.");

  const outcomeKey = [rfcEmisor, new URL(portalUrl).hostname.toLowerCase(), "portal_blocked"].join("|");
  outcomeRef = appRef.collection("billingPortalOutcomes")
    .doc(buildPortalKnowledgeDocumentId(outcomeKey));
  const previousSnapshot = await outcomeRef.get();
  previousOutcome = previousSnapshot.exists ? previousSnapshot.data() : null;
  await rememberSharedPortalOutcome({
    rfcEmisor,
    portalUrl,
    reason: "portal_blocked",
    status: "needs_user_action",
    statusMessage: "Controlled test: route to Capa C without issuing",
    source: "cloud_e2e_c_smoke",
    metadata: { smoke: true, uid, jobId, probeId },
  });

  const correction = confirmedCorrection(rawJob, ocrJob.ticket);
  await sendCommand(idToken, jobId, `confirm-${probeId}`, "confirm_ocr", { correction });
  await waitForJob(
    idToken,
    jobId,
    (job) => job?.status === "needs_user_action" &&
      (job?.userAction?.reason === "portal_blocked" || job?.error?.code === "portal_blocked"),
    "Portal router to Capa C",
  );

  await sendCommand(idToken, jobId, `resume-${probeId}`, "request_capa_c_resume", {});
  const handoffJob = await waitForJob(
    idToken,
    jobId,
    (job) => job?.status === "needs_user_action" &&
      job?.userAction?.mobileHandoff?.kind === "flutter_webview_handoff.v1" &&
      job?.userAction?.interactiveSession?.status === "ready" &&
      job?.userAction?.interactiveSession?.mode === "flutter_webview",
    "Capa C Flutter handoff",
  );

  const events = await apiRequest(`/v1/billing/jobs/${jobId}/events?limit=50`, idToken);
  const eventTypes = new Set((events.data ?? []).map((event) => event.type));
  for (const type of [
    "ocr_started",
    "ocr_completed",
    "manual_correction",
    "portal_manual_outcome_remembered",
    "capa_c_mobile_handoff_ready",
  ]) assert(eventTypes.has(type), `Expected event is missing: ${type}`);
  assert(![...eventTypes].some((type) => String(type).startsWith("b3_")), "B3 ran unexpectedly");
  assert(!handoffJob.result?.xmlUrl && !handoffJob.result?.pdfUrl, "Smoke test issued a CFDI unexpectedly");

  await cleanupProbe();
  cleaned = true;
  console.log(JSON.stringify({
    ok: true,
    status: handoffJob.status,
    reason: handoffJob.userAction?.reason ?? null,
    elapsedMs: Date.now() - startedAt,
    path: ["api", "ocr", "confirm_ocr", "portal_router", "capa_c", "flutter_webview"],
    extracted: {
      rfcEmisor,
      portalHost: new URL(portalUrl).hostname,
      fecha: correction.fecha ?? null,
      monto: correction.monto ?? null,
      folioOrTicket: correction.folio ?? correction.ticketId ?? null,
    },
    b3Started: false,
    cfdiIssued: false,
    handoffReady: true,
    cleaned,
  }, null, 2));
} catch (error) {
  try {
    await cleanupProbe();
    cleaned = true;
  } catch {
    // Preserve the original smoke-test error.
  }
  console.error(JSON.stringify({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
    jobId,
    probeUid: uid,
    lastStatus,
    cleaned,
  }, null, 2));
  process.exitCode = 1;
} finally {
  if (outcomeRef) {
    if (previousOutcome) await outcomeRef.set(previousOutcome, { merge: false }).catch(() => {});
    else await outcomeRef.delete().catch(() => {});
  }
}
