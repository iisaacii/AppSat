import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getFirebaseDb } from "../config/firebase.mjs";
import { getFirestoreRoot } from "../config/env.mjs";
import { buildOcrCheckpoint } from "../orchestrator/ocr-checkpoint.mjs";
import {
  buildPortalKnowledgeDocumentId,
  rememberSharedPortalOutcome,
} from "../portals/portal-knowledge-repository.mjs";

const timeoutMs = positiveInteger(process.env.PORTAL_ROUTER_SMOKE_TIMEOUT_MS, 120_000);
const pollMs = positiveInteger(process.env.PORTAL_ROUTER_SMOKE_POLL_MS, 2_000);
const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
const uid = `smoke_portal_${suffix}`;
const jobId = `portal_router_${suffix}`;
const rfcEmisor = `TST010101${suffix.slice(0, 3).toUpperCase()}`;
const portalUrl = "https://example.com/easysat-portal-smoke";
const ticketFileUrl = `mock://portal-router-smoke-${suffix}.jpg`;
const now = new Date().toISOString();

process.env.PORTAL_KNOWLEDGE_STORE = "firestore";

const db = getFirebaseDb();
const { collection, document } = getFirestoreRoot();
const appRef = db.collection(collection).doc(document);
const userRef = appRef.collection("users").doc(uid);
const jobRef = userRef.collection("facturaJobs").doc(jobId);
const outcomeKey = [rfcEmisor, "example.com", "portal_blocked"].join("|");
const outcomeRef = appRef
  .collection("billingPortalOutcomes")
  .doc(buildPortalKnowledgeDocumentId(outcomeKey));

const extraction = {
  rfcEmisor,
  folio: `SMOKE${suffix.toUpperCase()}`,
  fecha: now.slice(0, 10),
  monto: 1,
  portalUrl,
  portalCandidates: [portalUrl],
  ocrEngine: "cloud_portal_router_smoke",
  ocrText: `RFC ${rfcEmisor} TOTAL 1.00 PORTAL ${portalUrl}`,
  ocrTextPreview: `RFC ${rfcEmisor} TOTAL 1.00`,
  ocrConfidence: {
    rfcEmisor: 0.99,
    folio: 0.99,
    fecha: 0.99,
    monto: 0.99,
  },
  ocrCandidates: {
    rfc: [rfcEmisor],
    folioVenta: [`SMOKE${suffix.toUpperCase()}`],
    fecha: [now.slice(0, 10)],
    monto: [1],
    portalUrls: [portalUrl],
  },
};

const taxProfile = {
  rfc: "XAXX010101000",
  legalName: "PERSONA CONTRIBUYENTE DEMO",
  email: "pruebas@easysat.dev",
  fiscalRegime: "605 - Sueldos y Salarios e Ingresos Asimilados a Salarios",
  fiscalRegimes: ["605 - Sueldos y Salarios e Ingresos Asimilados a Salarios"],
  cfdiUse: "S01 - Sin efectos fiscales",
  postalCode: "54040",
  country: "MEXICO",
};

let terminalJob = null;
let safeToDeleteJob = false;

try {
  await rememberSharedPortalOutcome({
    rfcEmisor,
    portalUrl,
    reason: "portal_blocked",
    status: "needs_user_action",
    statusMessage: "Prueba controlada: portal bloqueado conocido",
    source: "cloud_portal_router_smoke",
    metadata: { smoke: true, uid, jobId },
  });

  await jobRef.set({
    id: jobId,
    uid,
    contractVersion: "factura-job.v1",
    source: "cloud_portal_router_smoke",
    ticketFileUrl,
    rfcReceptor: taxProfile.rfc,
    taxProfileId: "billing_lab_default",
    taxProfile,
    ...extraction,
    extractedData: extraction,
    ocrCheckpoint: buildOcrCheckpoint({
      job: { ticketFileUrl },
      extracted: extraction,
    }),
    ocrReviewConfirmed: true,
    ocrReview: {
      status: "confirmed",
      confirmedAt: now,
      confirmedBy: "cloud_portal_router_smoke",
    },
    portalCandidateUrl: portalUrl,
    portalCandidates: [portalUrl],
    portalFinalSubmitApproved: false,
    workflowStage: "portal",
    status: "pending",
    statusMessage: "Prueba controlada de router Portal/B3",
    attemptCount: 0,
    claimedBy: null,
    claimId: null,
    leaseVersion: 0,
    heartbeatAt: null,
    leaseExpiresAt: null,
    retryAt: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await jobRef.collection("events").add({
    type: "created",
    status: "pending",
    message: "Prueba controlada de router Portal/B3 creada",
    actor: "smoke",
    workerId: null,
    metadata: { smoke: true },
    createdAt: FieldValue.serverTimestamp(),
  });

  terminalJob = await waitForTerminalJob(jobRef);
  safeToDeleteJob = true;
  const eventsSnap = await jobRef.collection("events").orderBy("createdAt", "asc").get();
  const eventTypes = eventsSnap.docs.map((event) => event.data().type);

  assert(terminalJob.status === "needs_user_action", `Expected needs_user_action, got ${terminalJob.status}`);
  assert(
    terminalJob.reason === "portal_blocked" || terminalJob.userAction?.reason === "portal_blocked",
    `Expected portal_blocked, got ${terminalJob.reason ?? terminalJob.userAction?.reason ?? "missing"}`,
  );
  assert(Number(terminalJob.attemptCount) === 1, `Expected one worker attempt, got ${terminalJob.attemptCount}`);
  assert(eventTypes.includes("portal_manual_outcome_remembered"), "Remembered portal outcome event is missing");
  assert(!eventTypes.some((type) => String(type).startsWith("b3_")), "B3 must not run for a known manual block");

  console.log(JSON.stringify({
    ok: true,
    status: terminalJob.status,
    reason: terminalJob.reason ?? terminalJob.userAction?.reason ?? null,
    attemptCount: terminalJob.attemptCount,
    workflowStage: terminalJob.workflowStage,
    rememberedOutcomeUsed: true,
    b3Started: false,
    eventTypes,
  }, null, 2));
} finally {
  const latestSnap = await jobRef.get().catch(() => null);
  const latestStatus = latestSnap?.exists ? latestSnap.data()?.status : null;
  safeToDeleteJob ||= !latestSnap?.exists || [
    "needs_user_action",
    "completed",
    "resolved",
    "cancelled",
    "failed",
  ].includes(latestStatus);

  if (safeToDeleteJob) {
    await deleteJobTree(jobRef);
    await userRef.delete().catch(() => {});
  } else {
    console.error(`Smoke job left for inspection because it is still active: ${uid}/${jobId} (${latestStatus})`);
  }

  await outcomeRef.delete().catch(() => {});
}

async function waitForTerminalJob(ref) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const snap = await ref.get();
    if (!snap.exists) {
      throw new Error("Portal smoke job disappeared before reaching a terminal state");
    }

    const data = snap.data();
    if (["needs_user_action", "completed", "resolved", "cancelled", "failed"].includes(data.status)) {
      return data;
    }
    if (data.status === "retry_scheduled") {
      throw new Error(`Portal smoke job scheduled a retry: ${safeError(data)}`);
    }

    await delay(pollMs);
  }

  throw new Error(`Timed out waiting for Portal/B3 worker after ${timeoutMs}ms`);
}

async function deleteJobTree(ref) {
  const eventRefs = await ref.collection("events").listDocuments();
  for (let offset = 0; offset < eventRefs.length; offset += 400) {
    const batch = db.batch();
    for (const eventRef of eventRefs.slice(offset, offset + 400)) batch.delete(eventRef);
    await batch.commit();
  }
  await ref.delete().catch(() => {});
}

function safeError(job) {
  return String(job.reason ?? job.lastError?.code ?? job.error?.code ?? "unknown").slice(0, 160);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
