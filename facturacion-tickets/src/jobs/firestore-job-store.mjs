import { randomUUID } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import {
  isDemoFinalSubmitApproved,
  getEnv,
  getFirestoreRoot,
  getWorkerId,
  getWorkerLeaseDurationMs,
  getWorkerMaxAttempts,
} from "../config/env.mjs";
import { getFirebaseDb } from "../config/firebase.mjs";
import { normalizeStoredTaxProfile } from "../fiscal/stored-tax-profile.mjs";
import { buildBillingJobCommandTransition } from "./billing-job-command.service.mjs";
import { JobClaimLostError } from "./job-claim.error.mjs";
import {
  buildClaimPresentation,
  isJobEligibleForWorkerLane,
  normalizeWorkerLane,
} from "./job-workflow.mjs";

const collectionGroupName = "facturaJobs";
const commandCollectionGroupName = "billingJobCommands";
const leasedStatuses = new Set(["ocr_processing", "portal_processing", "capa_c_preparing"]);
const knownJobPaths = new Map();
const dueQueryLimit = getNumberConfig("WORKER_DUE_QUERY_LIMIT", 25);
const demoTaxProfile = {
  rfc: "XAXX010101000",
  legalName: "PERSONA CONTRIBUYENTE DEMO",
  email: "pruebas@appsat.dev",
  fiscalRegime: "605 - Sueldos y Salarios e Ingresos Asimilados a Salarios",
  fiscalRegimes: ["605 - Sueldos y Salarios e Ingresos Asimilados a Salarios"],
  cfdiUse: "S01 - Sin efectos fiscales",
  postalCode: "54040",
  street: "CAOBA",
  exteriorNumber: "23",
  interiorNumber: "",
  neighborhood: "VALLE DE LOS PINOS",
  municipality: "TLALNEPANTLA DE BAZ",
  state: "MEXICO",
  country: "MEXICO",
};

export async function findPendingFirestoreJob(options = {}) {
  const workerLane = normalizeWorkerLane(options.lane);
  const db = getFirebaseDb();
  const workerJobs = getWorkerJobsCollection(db);

  if (workerJobs) {
    const directJob = await findPendingOrExpiredInCollection(workerJobs, { lane: workerLane });
    return directJob;
  }

  if (isCollectionGroupEnabled()) {
    return findPendingOrExpiredInQuery(db.collectionGroup(collectionGroupName), { lane: workerLane });
  }

  // Compatibility fallback for environments where collection-group queries
  // were intentionally disabled. This path does not scale with user count.
  return findPendingJobByUserScan(db, { lane: workerLane });
}

export async function getFirestoreJobByIdentity({ uid, jobId } = {}) {
  assertFirestoreDocumentId(uid, "uid");
  assertFirestoreDocumentId(jobId, "jobId");
  const db = getFirebaseDb();
  const { collection, document } = getFirestoreRoot();
  const snapshot = await db
    .collection(collection)
    .doc(document)
    .collection("users")
    .doc(uid)
    .collection(collectionGroupName)
    .doc(jobId)
    .get();

  return snapshot.exists ? mapJobDoc(snapshot) : null;
}

export async function processNextFirestoreClientCommand() {
  const processed = await processPendingFirestoreClientCommands({ limit: 1 });
  return processed[0] ?? null;
}

export async function processPendingFirestoreClientCommands({ limit = dueQueryLimit } = {}) {
  const db = getFirebaseDb();
  const batchLimit = Math.max(1, Math.min(dueQueryLimit, Math.floor(Number(limit) || 1)));
  const commands = await db
    .collectionGroup(commandCollectionGroupName)
    .where("status", "==", "pending")
    .limit(batchLimit)
    .get();

  if (commands.empty) {
    return [];
  }

  const ordered = [...commands.docs].sort(
    (left, right) => getDateMs(left.data().requestedAt) - getDateMs(right.data().requestedAt),
  );

  const results = [];
  for (const commandDoc of ordered.slice(0, batchLimit)) {
    const result = await processFirestoreClientCommand(db, commandDoc.ref);
    if (result) {
      results.push(result);
    }
  }

  return results;
}

async function processFirestoreClientCommand(db, commandRef) {
  return db.runTransaction(async (transaction) => {
    const commandSnap = await transaction.get(commandRef);
    if (!commandSnap.exists || commandSnap.data().status !== "pending") {
      return null;
    }

    const command = commandSnap.data();
    const userRef = commandRef.parent.parent;
    const uid = userRef?.id ?? null;
    const jobId = String(command.jobId ?? "").trim();

    if (!userRef || !uid || !jobId) {
      transaction.update(commandRef, {
        status: "rejected",
        result: { reason: "invalid_command_path" },
        processedAt: FieldValue.serverTimestamp(),
      });
      return { commandId: commandRef.id, status: "rejected", reason: "invalid_command_path" };
    }

    const jobRef = userRef.collection(collectionGroupName).doc(jobId);
    const jobSnap = await transaction.get(jobRef);
    const transition = buildBillingJobCommandTransition({
      job: jobSnap.exists ? jobSnap.data() : null,
      command,
      uid,
      serverTimestamp: FieldValue.serverTimestamp(),
    });

    if (!transition.ok) {
      transaction.update(commandRef, {
        status: "rejected",
        result: {
          reason: transition.reason,
          message: transition.message,
        },
        processedAt: FieldValue.serverTimestamp(),
      });
      return {
        commandId: commandRef.id,
        jobId,
        type: command.type ?? null,
        status: "rejected",
        reason: transition.reason,
      };
    }

    transaction.update(jobRef, transition.patch);
    transaction.update(commandRef, {
      status: "processed",
      result: { status: transition.patch.status },
      processedAt: FieldValue.serverTimestamp(),
    });
    transaction.set(
      jobRef.collection("events").doc(),
      buildEventDoc(null, {
        ...transition.event,
        actor: "worker",
        metadata: {
          ...(transition.event.metadata ?? {}),
          commandId: commandRef.id,
          commandType: command.type,
        },
      }),
    );
    knownJobPaths.set(jobId, jobRef.path);

    return {
      commandId: commandRef.id,
      jobId,
      uid,
      type: command.type,
      status: "processed",
      workflowStage: transition.patch.workflowStage ?? null,
      jobStatus: transition.patch.status ?? null,
    };
  });
}

export async function updateFirestoreJob(jobId, patch) {
  const db = getFirebaseDb();
  const workerJobs = getWorkerJobsCollection(db);
  const cleanPatch = removeUndefinedDeep(patch);

  let ref;
  if (workerJobs) {
    ref = workerJobs.doc(jobId);
  } else {
    const knownPath = knownJobPaths.get(jobId);
    if (knownPath) {
      ref = db.doc(knownPath);
    } else {
      if (!isCollectionGroupEnabled()) {
        throw new Error(`Firestore job path not known: ${jobId}`);
      }
      const snap = await db
        .collectionGroup(collectionGroupName)
        .where("id", "==", jobId)
        .limit(1)
        .get();

      if (snap.empty) {
        throw new Error(`Firestore job not found: ${jobId}`);
      }
      ref = snap.docs[0].ref;
    }
  }

  const currentDoc = await ref.get();
  const currentData = currentDoc.data() ?? {};
  applyInvoiceCompletionGuard(cleanPatch, currentData);

  await ref.update({
    ...cleanPatch,
    updatedAt: FieldValue.serverTimestamp(),
  });

  const updated = await ref.get();
  return mapJobDoc(updated);
}

export async function updateClaimedFirestoreJob(job, patch) {
  const db = getFirebaseDb();
  const ref = getJobRef(db, job);
  const cleanPatch = removeUndefinedDeep(patch);

  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    assertClaimOwned(snap, job);
    applyInvoiceCompletionGuard(cleanPatch, snap.data() ?? {});
    transaction.update(ref, {
      ...cleanPatch,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  const updated = await ref.get();
  return mapJobDoc(updated);
}

export async function renewFirestoreJobLease(job) {
  const db = getFirebaseDb();
  const ref = getJobRef(db, job);
  const leaseExpiresAt = Timestamp.fromDate(new Date(Date.now() + getWorkerLeaseDurationMs()));

  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const data = snap.data();

    if (!snap.exists || !ownsClaim(data, job) || !leasedStatuses.has(data.status)) {
      return false;
    }

    transaction.update(ref, {
      heartbeatAt: FieldValue.serverTimestamp(),
      leaseExpiresAt,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
}

export async function appendClaimedFirestoreJobEvent(job, event, jobPatch = null) {
  const db = getFirebaseDb();
  const ref = getJobRef(db, job);
  const eventRef = ref.collection("events").doc();
  const cleanPatch = jobPatch ? removeUndefinedDeep(jobPatch) : null;

  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    assertClaimOwned(snap, job);

    if (cleanPatch) {
      transaction.update(ref, {
        ...cleanPatch,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    transaction.set(
      eventRef,
      buildEventDoc(eventRef.id, {
        ...event,
        metadata: {
          ...(event.metadata ?? {}),
          claimId: job.claimId,
          leaseVersion: job.leaseVersion ?? null,
        },
      }),
    );
  });
}

function applyInvoiceCompletionGuard(cleanPatch, currentData) {
  const hasFiscalXml =
    hasValue(cleanPatch.resultXmlUrl) ||
    hasValue(cleanPatch.resultXmlStoragePath) ||
    hasValue(currentData.resultXmlUrl) ||
    hasValue(currentData.resultXmlStoragePath);
  const validation = cleanPatch.cfdiValidationResult ?? currentData.cfdiValidationResult;
  const hasValidatedInvoice = hasFiscalXml && validation?.ok === true;

  if (hasValidatedInvoice && (cleanPatch.status === "needs_user_action" || (!cleanPatch.status && currentData.status === "needs_user_action"))) {
    cleanPatch.status = "completed";
    cleanPatch.statusMessage = hasValue(cleanPatch.statusMessage)
      ? cleanPatch.statusMessage
      : "Factura generada correctamente. XML y PDF guardados.";
  }
}

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function assertClaimOwned(snap, job) {
  if (!snap.exists || !ownsClaim(snap.data(), job)) {
    throw new JobClaimLostError(job.id);
  }
}

function ownsClaim(data, job) {
  if (!job?.claimId || data?.claimId !== job.claimId || data?.claimedBy !== job.claimedBy) {
    return false;
  }

  return job.leaseVersion == null || Number(data.leaseVersion ?? 0) === Number(job.leaseVersion);
}

function removeUndefinedDeep(value) {
  if (Array.isArray(value)) {
    return value.map(removeUndefinedDeep);
  }

  if (value && typeof value === "object" && !(value instanceof Date) && !(value instanceof Timestamp)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, removeUndefinedDeep(entry)]),
    );
  }

  return value;
}

export async function appendFirestoreJobEvent(jobId, event) {
  const db = getFirebaseDb();
  const ref = getJobRef(db, { id: jobId });
  const eventRef = ref.collection("events").doc();

  await eventRef.set(buildEventDoc(eventRef.id, event));
}

export async function claimFirestoreJob(job, options = {}) {
  const workerLane = normalizeWorkerLane(options.lane);
  const db = getFirebaseDb();
  const ref = getJobRef(db, job);
  const workerId = getWorkerId();
  const claimId = randomUUID();

  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);

    const data = snap.data();
    const defaultTaxProfilePatch = await resolveDefaultTaxProfilePatch(transaction, ref, data);

    if (!snap.exists || !isClaimable(data, { lane: workerLane })) {
      return null;
    }

    const attemptCount = (data.attemptCount ?? 0) + 1;

    if (attemptCount > getWorkerMaxAttempts()) {
      transaction.update(ref, {
        status: "failed",
        statusMessage: "Se agotaron los intentos de procesamiento",
        error: "max_attempts_exceeded",
        claimedBy: null,
        claimId: null,
        heartbeatAt: null,
        leaseExpiresAt: null,
        retryAt: null,
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.set(
        ref.collection("events").doc(),
        buildEventDoc(null, {
          type: "failed",
          status: "failed",
          message: "Se agotaron los intentos de procesamiento",
          actor: "worker",
          workerId,
          attemptCount,
          metadata: { reason: "max_attempts_exceeded" },
        }),
      );
      return null;
    }

    const leaseExpiresAt = Timestamp.fromDate(new Date(Date.now() + getWorkerLeaseDurationMs()));
    const leaseVersion = Number(data.leaseVersion ?? 0) + 1;

    const requestedStatus = data.status;
    const claim = buildClaimPresentation(data, workerLane);
    const claimStatus = claim.status;
    const claimMessage = claim.statusMessage;

    transaction.update(ref, {
      ...defaultTaxProfilePatch,
      status: claimStatus,
      workflowStage: claim.workflowStage,
      statusMessage: claimMessage,
      error: null,
      attemptCount: FieldValue.increment(1),
      claimedBy: workerId,
      claimId,
      leaseVersion,
      heartbeatAt: FieldValue.serverTimestamp(),
      processingStartedAt: FieldValue.serverTimestamp(),
      leaseExpiresAt,
      retryAt: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.set(
      ref.collection("events").doc(),
      buildEventDoc(null, {
        type: "claimed",
        status: claimStatus,
        message: "Worker reclamo el job",
        actor: "worker",
        workerId,
        attemptCount,
        metadata: {
          claimId,
          leaseVersion,
          recoveredFromStatus: requestedStatus,
          leaseExpiresAt: leaseExpiresAt.toDate().toISOString(),
          workerLane: claim.lane,
          workflowStage: claim.workflowStage,
        },
      }),
    );

    return {
      ...data,
      ...defaultTaxProfilePatch,
      id: data.id ?? snap.id,
      _firestorePath: ref.path,
      status: claimStatus,
      workflowStage: claim.workflowStage,
      requestedStatus,
      statusMessage: claimMessage,
      error: null,
      attemptCount,
      claimedBy: workerId,
      claimId,
      leaseVersion,
      heartbeatAt: new Date().toISOString(),
      leaseExpiresAt: leaseExpiresAt.toDate().toISOString(),
      retryAt: null,
      createdAt: normalizeDate(data.createdAt),
      updatedAt: new Date().toISOString(),
    };
  });
}

async function resolveDefaultTaxProfilePatch(transaction, jobRef, data) {
  if (data?.taxProfile) {
    return {};
  }

  const userRef = jobRef.parent.parent;

  if (!userRef) {
    return {};
  }

  const taxProfileSnap = await transaction.get(
    userRef.collection("contribuyentes").doc("billing_lab_default"),
  );

  if (!taxProfileSnap.exists) {
    return {};
  }

  const taxProfile = normalizeStoredTaxProfile(taxProfileSnap.data());

  if (!taxProfile) {
    return {};
  }

  return {
    taxProfileId: "billing_lab_default",
    taxProfile,
  };
}

export async function seedDemoFirestoreJob() {
  const db = getFirebaseDb();
  const { collection, document, workerUid } = getFirestoreRoot();
  const uid = workerUid ?? "demo_user";
  const jobId = "job_demo_001";
  const jobRef = db
    .collection(collection)
    .doc(document)
    .collection("users")
    .doc(uid)
    .collection(collectionGroupName)
    .doc(jobId);
  const eventRef = jobRef.collection("events").doc();
  const batch = db.batch();
  const existingEvents = await jobRef.collection("events").listDocuments();

  for (const existingEvent of existingEvents.slice(0, 400)) {
    batch.delete(existingEvent);
  }

  batch.set(jobRef, {
      id: jobId,
      uid,
      ticketFileUrl: "mock://ticket-oxxo.jpg",
      rfcReceptor: "XAXX010101000",
      taxProfileId: "billing_lab_default",
      taxProfile: demoTaxProfile,
      portalFinalSubmitApproved: isDemoFinalSubmitApproved(),
      rfcEmisor: null,
      folio: null,
      fecha: null,
      monto: null,
      status: "pending",
      statusMessage: "Ticket recibido",
      resultXmlUrl: null,
      resultPdfUrl: null,
      error: null,
      lastError: null,
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
  batch.set(
    eventRef,
    buildEventDoc(eventRef.id, {
      type: "created",
      status: "pending",
      message: "Job demo creado",
      actor: "seed",
      workerId: null,
      metadata: { ticketFileUrl: "mock://ticket-oxxo.jpg" },
    }),
  );

  await batch.commit();
}

function getWorkerJobsCollection(db) {
  const { collection, document, workerUid } = getFirestoreRoot();

  if (!workerUid) {
    return null;
  }

  return db
    .collection(collection)
    .doc(document)
    .collection("users")
    .doc(workerUid)
    .collection(collectionGroupName);
}

function getJobRef(db, job) {
  if (job._firestorePath) {
    return db.doc(job._firestorePath);
  }

  const knownPath = knownJobPaths.get(job.id);

  if (knownPath) {
    return db.doc(knownPath);
  }

  const workerJobs = getWorkerJobsCollection(db);

  if (workerJobs) {
    return workerJobs.doc(job.id);
  }

  throw new Error(`Firestore job path not known: ${job.id}`);
}

async function findPendingJobByUserScan(db, options = {}) {
  const { collection, document } = getFirestoreRoot();
  const userRefs = await db.collection(collection).doc(document).collection("users").listDocuments();

  for (const userRef of userRefs) {
    const job = await findPendingOrExpiredInCollection(userRef.collection(collectionGroupName), options);

    if (job) {
      return job;
    }
  }

  return null;
}

async function findPendingOrExpiredInCollection(collectionRef, options = {}) {
  return findPendingOrExpiredInQuery(collectionRef, options);
}

async function findPendingOrExpiredInQuery(query, options = {}) {
  const workerLane = normalizeWorkerLane(options.lane);
  const pendingDocs = await findStatusDocsForLane(query, "pending", workerLane);
  const pendingJob = pendingDocs
    .map(mapJobDoc)
    .filter((job) => isJobEligibleForWorkerLane(job, workerLane))
    .sort((left, right) => getDateMs(left.createdAt) - getDateMs(right.createdAt))[0];

  if (pendingJob) {
    return pendingJob;
  }

  const capaCResumeSnap = await query.where("status", "==", "capa_c_resume_requested").limit(1).get();

  if (!capaCResumeSnap.empty) {
    const capaCJob = capaCResumeSnap.docs
      .map(mapJobDoc)
      .find((job) => isJobEligibleForWorkerLane(job, workerLane));
    if (capaCJob) return capaCJob;
  }

  const dueRetryJob = await findFirstClaimableByStatus(query, "retry_scheduled", isDueRetry, "retryAt", workerLane);

  if (dueRetryJob) {
    return dueRetryJob;
  }

  const expiredLeaseJob = await findFirstClaimableByStatus(
    query,
    "ocr_processing",
    isExpiredLease,
    "leaseExpiresAt",
    workerLane,
  );

  if (expiredLeaseJob) {
    return expiredLeaseJob;
  }

  const expiredCapaCJob = await findFirstClaimableByStatus(
    query,
    "capa_c_preparing",
    isExpiredLease,
    "leaseExpiresAt",
    workerLane,
  );

  if (expiredCapaCJob) {
    return expiredCapaCJob;
  }

  const expiredPortalJob = await findFirstClaimableByStatus(
    query,
    "portal_processing",
    isExpiredLease,
    "leaseExpiresAt",
    workerLane,
  );

  if (expiredPortalJob) {
    return expiredPortalJob;
  }

  return null;
}

function isClaimable(data, options = {}) {
  return (
    isJobEligibleForWorkerLane(data, options.lane) &&
    (data.status === "pending" || data.status === "capa_c_resume_requested" || isDueRetry(data) || isExpiredLease(data))
  );
}

async function findFirstClaimableByStatus(query, status, predicate, dateField, workerLane = "all") {
  const docs = await findStatusDocsForLane(query, status, workerLane);
  const jobs = docs
    .map(mapJobDoc)
    .filter((job) => predicate(job) && isJobEligibleForWorkerLane(job, workerLane))
    .sort((a, b) => getDateMs(a[dateField]) - getDateMs(b[dateField]));

  return jobs[0] ?? null;
}

async function findStatusDocsForLane(query, status, workerLane) {
  if (workerLane === "all") {
    const snap = await query.where("status", "==", status).limit(dueQueryLimit).get();
    return snap.docs;
  }

  const scopedSnap = await query
    .where("status", "==", status)
    .where("workflowStage", "==", workerLane)
    .limit(dueQueryLimit)
    .get();

  if (!scopedSnap.empty) {
    return scopedSnap.docs;
  }

  // Legacy jobs did not have workflowStage. Read a bounded set and infer their
  // lane so deployments can be upgraded without a data migration.
  const legacySnap = await query.where("status", "==", status).limit(dueQueryLimit).get();
  return legacySnap.docs;
}

function isDueRetry(data) {
  if (data.status !== "retry_scheduled") {
    return false;
  }

  if (!data.retryAt) {
    return true;
  }

  return getDateMs(data.retryAt) <= Date.now();
}

function isExpiredLease(data) {
  if (!leasedStatuses.has(data.status) || !data.leaseExpiresAt) {
    return false;
  }

  return getDateMs(data.leaseExpiresAt) <= Date.now();
}

function isCollectionGroupEnabled() {
  return getEnv("FIRESTORE_ENABLE_COLLECTION_GROUP", "true") === "true";
}

function mapJobDoc(doc) {
  const data = doc.data();
  knownJobPaths.set(data.id ?? doc.id, doc.ref.path);

  return {
    ...data,
    id: data.id ?? doc.id,
    _firestorePath: doc.ref.path,
    createdAt: normalizeDate(data.createdAt),
    updatedAt: normalizeDate(data.updatedAt),
    processingStartedAt: normalizeDate(data.processingStartedAt),
    heartbeatAt: normalizeDate(data.heartbeatAt),
    leaseExpiresAt: normalizeDate(data.leaseExpiresAt),
    retryAt: normalizeDate(data.retryAt),
  };
}

function assertFirestoreDocumentId(value, label) {
  const normalized = String(value ?? "").trim();

  if (!normalized || normalized.length > 128 || normalized.includes("/")) {
    throw new Error(`Invalid Firestore ${label}.`);
  }
}

function normalizeDate(value) {
  if (value instanceof Timestamp) {
    return value.toDate().toISOString();
  }

  return value ?? null;
}

function getDateMs(value) {
  if (value instanceof Timestamp) {
    return value.toDate().getTime();
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  return new Date(value).getTime();
}

function getNumberConfig(name, fallback) {
  const value = Number(getEnv(name, fallback));
  return Number.isFinite(value) ? value : fallback;
}

function buildEventDoc(id, event) {
  return {
    ...(id ? { id } : {}),
    type: event.type,
    status: event.status ?? null,
    message: event.message ?? null,
    actor: event.actor ?? "worker",
    workerId: Object.hasOwn(event, "workerId") ? event.workerId : getWorkerId(),
    attemptCount: event.attemptCount ?? null,
    metadata: event.metadata ?? {},
    createdAt: FieldValue.serverTimestamp(),
  };
}
