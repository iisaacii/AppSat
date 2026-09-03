import { FieldValue } from "firebase-admin/firestore";
import { getFirestoreRoot } from "../config/env.mjs";
import { getFirebaseDb } from "../config/firebase.mjs";

const uid = getCliOption("uid");
const jobId = getCliOption("job-id");
const portalUrl = getCliOption("portal-url");
const rfcEmisor = getCliOption("rfc-emisor");
const reset = getCliFlag("reset");

if (!uid) {
  throw new Error("Missing --uid=UID");
}

if (!portalUrl || !isAllowedPortalUrl(portalUrl)) {
  throw new Error("Missing or invalid --portal-url. Use http://, https:// or file://");
}

const db = getFirebaseDb();
const { collection, document } = getFirestoreRoot();
const jobsRef = db
  .collection(collection)
  .doc(document)
  .collection("users")
  .doc(uid)
  .collection("facturaJobs");
const jobRef = jobId ? jobsRef.doc(jobId) : await findLatestJobRef(jobsRef);

if (!jobRef) {
  throw new Error(`No facturaJobs found for uid ${uid}`);
}

const patch = {
  aiPortalUrl: portalUrl,
  portalCandidateUrl: portalUrl,
  portalCandidates: [
    {
      url: portalUrl,
      source: "dev_prepare_ai_portal_job",
      confidence: 1,
      createdAt: new Date().toISOString(),
    },
  ],
  updatedAt: FieldValue.serverTimestamp(),
};

if (rfcEmisor) {
  patch.rfcEmisor = rfcEmisor.toUpperCase();
  patch.manualOverrides = {
    rfcEmisor: rfcEmisor.toUpperCase(),
  };
}

if (reset) {
  Object.assign(patch, {
    status: "pending",
    statusMessage: "Job preparado para Capa B Gemini",
    error: null,
    lastError: null,
    claimedBy: null,
    leaseExpiresAt: null,
    retryAt: null,
  });
}

await jobRef.update(patch);

const updated = await jobRef.get();
console.log(
  JSON.stringify(
    {
      id: updated.id,
      path: updated.ref.path,
      status: updated.data().status,
      aiPortalUrl: updated.data().aiPortalUrl,
      portalCandidates: updated.data().portalCandidates,
      rfcEmisor: updated.data().rfcEmisor ?? null,
      reset,
    },
    null,
    2,
  ),
);

async function findLatestJobRef(jobsRef) {
  const snap = await jobsRef.orderBy("updatedAt", "desc").limit(1).get();
  return snap.docs[0]?.ref ?? null;
}

function getCliOption(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

function getCliFlag(name) {
  return process.argv.includes(`--${name}`);
}

function isAllowedPortalUrl(value) {
  return /^(https?|file):\/\//i.test(String(value ?? "").trim());
}
