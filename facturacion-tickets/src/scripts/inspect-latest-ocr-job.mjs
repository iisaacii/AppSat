import { getFirestoreRoot, isPortalFinalSubmitEnabled } from "../config/env.mjs";
import { getFirebaseDb } from "../config/firebase.mjs";
import { loadPortalTemplates } from "../portals/portal-registry.mjs";

const db = getFirebaseDb();
const { collection, document } = getFirestoreRoot();
const uid = getCliOption("uid");
const jobId = getCliOption("job-id");
const templates = await loadPortalTemplates();

if (uid && jobId) {
  const doc = await db
    .collection(collection)
    .doc(document)
    .collection("users")
    .doc(uid)
    .collection("facturaJobs")
    .doc(jobId)
    .get();

  if (!doc.exists) {
    throw new Error(`Job not found: users/${uid}/facturaJobs/${jobId}`);
  }

  const eventsSnap = await doc.ref
    .collection("events")
    .orderBy("createdAt", "asc")
    .limit(25)
    .get();

  console.log(JSON.stringify({
    ...mapJob(doc),
    events: eventsSnap.docs.map(mapEvent),
  }, null, 2));
  process.exit(0);
}

if (uid) {
  const snap = await db
    .collection(collection)
    .doc(document)
    .collection("users")
    .doc(uid)
    .collection("facturaJobs")
    .orderBy("updatedAt", "desc")
    .limit(10)
    .get();

  console.log(JSON.stringify(snap.docs.map(mapJob), null, 2));
  process.exit(0);
}

const users = await db.collection(collection).doc(document).collection("users").listDocuments();
const jobs = [];

for (const userRef of users) {
  const snap = await userRef
    .collection("facturaJobs")
    .orderBy("updatedAt", "desc")
    .limit(5)
    .get();

  for (const doc of snap.docs) {
    const data = doc.data();

    if (
      data.ocrEngine ||
      data.ocrTextPreview ||
      data.ticketFileUrl?.startsWith("http") ||
      data.cfdiStorageMode
    ) {
      jobs.push(mapJob(doc));
    }
  }
}

jobs.sort((a, b) => {
  const scoreA = a.ocrEngine === "google_vision" ? 1 : 0;
  const scoreB = b.ocrEngine === "google_vision" ? 1 : 0;

  if (scoreA !== scoreB) {
    return scoreB - scoreA;
  }

  return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
});

console.log(JSON.stringify(jobs.slice(0, 5), null, 2));

function getCliOption(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

function mapJob(doc) {
  const data = doc.data();
  const finalSubmitReadiness = buildFinalSubmitReadiness(data);

  return {
    id: doc.id,
    path: doc.ref.path,
    status: data.status,
    statusMessage: data.statusMessage,
    error: data.error,
    rfcEmisor: data.rfcEmisor,
    rfcReceptor: data.rfcReceptor,
    folio: data.folio,
    fecha: data.fecha,
    monto: data.monto,
    taxProfileId: data.taxProfileId,
    taxProfile: data.taxProfile,
    portalFinalSubmitApproved: data.portalFinalSubmitApproved ?? null,
    ocrEngine: data.ocrEngine,
    ocrConfidence: data.ocrConfidence,
    ocrCandidates: data.ocrCandidates,
    ocrTextPreview: data.ocrTextPreview,
    resultXmlUrl: data.resultXmlUrl,
    resultPdfUrl: data.resultPdfUrl,
    resultXmlStoragePath: data.resultXmlStoragePath,
    resultPdfStoragePath: data.resultPdfStoragePath,
    cfdiStorageMode: data.cfdiStorageMode,
    cfdiStorageBucket: data.cfdiStorageBucket,
    cfdiStoredAt: data.cfdiStoredAt,
    aiPortalUrl: data.aiPortalUrl ?? null,
    portalCandidateUrl: data.portalCandidateUrl ?? null,
    portalCandidates: data.portalCandidates ?? null,
    autopilotDecision: summarizeAutopilotDecision(data.autopilotDecision),
    aiNavigationResult: summarizeAiNavigationResult(data.aiNavigationResult),
    fallbackResult: data.fallbackResult ?? null,
    forcedAiNavigation: data.forcedAiNavigation ?? null,
    portalRunResult: data.portalRunResult,
    finalSubmitReadiness,
    updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() ?? null,
  };
}

function summarizeAutopilotDecision(decision) {
  if (!decision) {
    return null;
  }

  return {
    mode: decision.mode ?? null,
    approveFinalSubmit: decision.approveFinalSubmit ?? null,
    approvalSource: decision.approvalSource ?? null,
    blockedBy: decision.blockedBy ?? [],
  };
}

function summarizeAiNavigationResult(result) {
  if (!result) {
    return null;
  }

  return {
    providerMode: result.providerMode ?? null,
    status: result.status ?? null,
    reason: result.reason ?? null,
    statusMessage: result.statusMessage ?? null,
    portalUrl: result.portalUrl ?? null,
    failure: result.failure ?? null,
    turns: Array.isArray(result.turns) ? result.turns.length : null,
    lastPlan: summarizeAiPlan(result.lastPlan),
    artifacts: result.artifacts ?? null,
    aiNavigationAttempts: result.aiNavigationAttempts ?? null,
    learnedTemplateCandidate: summarizeLearnedTemplateCandidate(result.learnedTemplateCandidate),
    learnedTemplateSave: result.learnedTemplateSave ?? null,
    autopilotDecision: summarizeAutopilotDecision(result.autopilotDecision),
  };
}

function summarizeAiPlan(plan) {
  if (!plan) {
    return null;
  }

  return {
    status: plan.status ?? null,
    confidence: plan.confidence ?? null,
    actions: Array.isArray(plan.actions) ? plan.actions.map((action) => action.type) : [],
    reason: plan.reason ?? null,
  };
}

function summarizeLearnedTemplateCandidate(candidate) {
  if (!candidate) {
    return null;
  }

  return {
    id: candidate.id ?? null,
    name: candidate.name ?? null,
    rfcEmisor: candidate.rfcEmisor ?? null,
    portalUrl: candidate.portalUrl ?? null,
    portalFamily: candidate.portalFamily ?? null,
    requiredFields: Array.isArray(candidate.requiredFields) ? candidate.requiredFields.length : null,
    steps: Array.isArray(candidate.steps) ? candidate.steps.length : null,
  };
}

function buildFinalSubmitReadiness(data) {
  const template = templates.find(
    (candidate) =>
      candidate.id === data.portalTemplateId ||
      (data.rfcEmisor && candidate.rfcEmisor === data.rfcEmisor),
  );
  const finalSubmitStep = template?.steps?.find((step) => step.type === "finalSubmit");
  const checks = {
    hasTemplate: Boolean(template),
    hasFinalSubmitStep: Boolean(finalSubmitStep),
    templateAllowsFinalSubmit: finalSubmitStep?.allowSubmit === true,
    workerAllowsFinalSubmit: isPortalFinalSubmitEnabled(),
    jobApprovedFinalSubmit: data.portalFinalSubmitApproved === true,
    previewReady: data.portalRunResult?.reason === "invoice_preview_ready",
  };
  const blockedBy = [];

  if (!checks.hasTemplate) blockedBy.push("template_missing");
  if (!checks.hasFinalSubmitStep) blockedBy.push("final_submit_step_missing");
  if (!checks.templateAllowsFinalSubmit) blockedBy.push("template_allow_submit_false");
  if (!checks.workerAllowsFinalSubmit) blockedBy.push("worker_allow_submit_false");
  if (!checks.jobApprovedFinalSubmit) blockedBy.push("job_final_submit_not_approved");
  if (!checks.previewReady) blockedBy.push("preview_not_ready");

  return {
    ready: blockedBy.length === 0,
    blockedBy,
    ...checks,
  };
}

function mapEvent(doc) {
  const data = doc.data();

  return {
    id: doc.id,
    type: data.type,
    status: data.status,
    message: data.message,
    actor: data.actor,
    workerId: data.workerId,
    attemptCount: data.attemptCount,
    metadata: data.metadata,
    createdAt: data.createdAt?.toDate?.()?.toISOString?.() ?? null,
  };
}
