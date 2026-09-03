import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getFirebaseDb } from "../config/firebase.mjs";
import { getFirestoreRoot } from "../config/env.mjs";

const timeoutMs = positiveInteger(process.env.CAPA_C_SMOKE_TIMEOUT_MS, 120_000);
const pollMs = positiveInteger(process.env.CAPA_C_SMOKE_POLL_MS, 2_000);
const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
const uid = `smoke_capa_c_${suffix}`;
const jobId = `capa_c_handoff_${suffix}`;
const rfcEmisor = `TST010101${suffix.slice(0, 3).toUpperCase()}`;
const portalUrl = `https://example.com/easysat-capa-c-smoke/${suffix}`;
const now = new Date().toISOString();
const folio = `SMOKE${suffix.toUpperCase()}`;

const db = getFirebaseDb();
const { collection, document } = getFirestoreRoot();
const appRef = db.collection(collection).doc(document);
const userRef = appRef.collection("users").doc(uid);
const jobRef = userRef.collection("facturaJobs").doc(jobId);

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

const checkpoint = {
  kind: "portal_checkpoint.v1",
  portalUrl,
  currentUrl: portalUrl,
  templateId: null,
  portalFamily: "cloud_smoke",
  portalName: "Portal sintetico Capa C",
  rfcEmisor,
  ticketData: {
    folio,
    ticketId: folio,
    fecha: now.slice(0, 10),
    monto: 1,
  },
  taxProfileId: "billing_lab_default",
  reason: "captcha_required",
};

let safeToDeleteJob = false;

try {
  await jobRef.set({
    id: jobId,
    uid,
    contractVersion: "factura-job.v1",
    source: "cloud_capa_c_handoff_smoke",
    rfcEmisor,
    rfcReceptor: taxProfile.rfc,
    folio,
    fecha: now.slice(0, 10),
    monto: 1,
    taxProfileId: "billing_lab_default",
    taxProfile,
    portalUrl,
    portalCandidateUrl: portalUrl,
    portalFinalSubmitApproved: false,
    reason: "captcha_required",
    userAction: {
      status: "user_action_required",
      reason: "captcha_required",
      expectedNextStep: "resume_interactive_checkpoint",
      title: "CAPTCHA requerido",
      message: "Prueba controlada de handoff Capa C",
      editableFields: [],
      checkpoint,
    },
    workflowStage: "capa_c",
    status: "capa_c_resume_requested",
    statusMessage: "Preparando prueba controlada de Flutter WebView",
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
    type: "capa_c_resume_requested",
    status: "capa_c_resume_requested",
    message: "Prueba controlada de handoff Capa C creada",
    actor: "smoke",
    workerId: null,
    metadata: { smoke: true },
    createdAt: FieldValue.serverTimestamp(),
  });

  const terminalJob = await waitForTerminalJob(jobRef);
  safeToDeleteJob = true;
  const eventsSnap = await jobRef.collection("events").orderBy("createdAt", "asc").get();
  const eventTypes = eventsSnap.docs.map((event) => event.data().type);
  const handoff = terminalJob.userAction?.mobileHandoff ?? terminalJob.mobileHandoff;
  const session = terminalJob.userAction?.interactiveSession ?? terminalJob.interactiveSession;

  assert(terminalJob.status === "needs_user_action", `Expected needs_user_action, got ${terminalJob.status}`);
  assert(terminalJob.reason === "captcha_required", `Expected captcha_required, got ${terminalJob.reason}`);
  assert(Number(terminalJob.attemptCount) === 1, `Expected one worker attempt, got ${terminalJob.attemptCount}`);
  assert(terminalJob.workflowStage === "manual", `Expected manual workflow stage, got ${terminalJob.workflowStage}`);
  assert(handoff?.kind === "flutter_webview_handoff.v1", "Flutter WebView handoff is missing");
  assert(handoff?.mode === "flutter_webview", `Unexpected handoff mode: ${handoff?.mode}`);
  assert(handoff?.initialUrl === portalUrl, `Unexpected handoff URL: ${handoff?.initialUrl}`);
  assert(handoff?.expectedUserAction === "resolve_captcha_and_continue", "CAPTCHA action is incorrect");
  assert(handoff?.prefillData?.ticket?.folio === folio, "Ticket prefill is missing");
  assert(handoff?.prefillData?.fiscal?.rfc === taxProfile.rfc, "Fiscal prefill is missing");
  assert(session?.mode === "flutter_webview", `Unexpected session mode: ${session?.mode}`);
  assert(session?.status === "ready", `Expected ready session, got ${session?.status}`);
  assert(eventTypes.includes("capa_c_resume_started"), "Capa C start event is missing");
  assert(eventTypes.includes("capa_c_mobile_handoff_ready"), "Mobile handoff event is missing");
  assert(!eventTypes.some((type) => String(type).startsWith("b3_")), "B3 must not run during Capa C handoff");
  assert(!eventTypes.includes("portal_started"), "Cloud browser must not open for Flutter handoff");

  console.log(JSON.stringify({
    ok: true,
    status: terminalJob.status,
    reason: terminalJob.reason,
    attemptCount: terminalJob.attemptCount,
    workflowStage: terminalJob.workflowStage,
    handoffKind: handoff.kind,
    handoffMode: handoff.mode,
    sessionStatus: session.status,
    ticketPrefillPresent: true,
    fiscalPrefillPresent: true,
    b3Started: false,
    cloudBrowserStarted: false,
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
}

async function waitForTerminalJob(ref) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const snap = await ref.get();
    if (!snap.exists) throw new Error("Capa C smoke job disappeared before reaching a terminal state");

    const data = snap.data();
    if (["needs_user_action", "completed", "resolved", "cancelled", "failed"].includes(data.status)) {
      return data;
    }
    if (data.status === "retry_scheduled") {
      throw new Error(`Capa C smoke scheduled a retry: ${safeError(data)}`);
    }

    await delay(pollMs);
  }

  throw new Error(`Timed out waiting for Capa C worker after ${timeoutMs}ms`);
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
