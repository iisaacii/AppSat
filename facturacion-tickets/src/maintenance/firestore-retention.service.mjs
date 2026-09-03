import { FieldValue, Timestamp } from "firebase-admin/firestore";
import {
  getAbandonedJobPurgeDays,
  getActionableJobRetentionDays,
  getBillingCommandRetentionDays,
  getFirestoreRoot,
  getInactiveTemplateCandidateRetentionDays,
  getMaintenanceBatchSize,
  getPortalArtifactRetentionDays,
  getTicketImageRetentionDays,
  isAbandonedJobPurgeEnabled,
} from "../config/env.mjs";
import { getFirebaseDb, getFirebaseStorageBucket } from "../config/firebase.mjs";
import {
  RETENTION_ACTIONS,
  buildExpiredJobPatch,
  evaluateBillingCommandRetention,
  evaluateJobRetention,
  evaluateStorageObjectRetention,
  evaluateTemplateCandidateRetention,
} from "./retention-policy.mjs";

export async function runFirestoreRetentionMaintenance({ execute = false, now = new Date() } = {}) {
  const policy = getRetentionConfig();
  const [jobs, commands, templateCandidates, storage] = await Promise.all([
    inspectStaleJobs({ now, policy, execute }),
    inspectStaleCommands({ now, policy, execute }),
    inspectInactiveTemplateCandidates({ now, policy, execute }),
    inspectStaleStorage({ now, policy, execute }),
  ]);

  return {
    ok: true,
    mode: execute ? "execute" : "dry_run",
    now: now.toISOString(),
    policy,
    jobs,
    commands,
    templateCandidates,
    storage,
  };
}

export function getRetentionConfig() {
  return {
    actionableDays: getActionableJobRetentionDays(),
    abandonedPurgeDays: getAbandonedJobPurgeDays(),
    purgeAbandonedJobs: isAbandonedJobPurgeEnabled(),
    ticketImageDays: getTicketImageRetentionDays(),
    portalArtifactDays: getPortalArtifactRetentionDays(),
    commandDays: getBillingCommandRetentionDays(),
    inactiveTemplateDays: getInactiveTemplateCandidateRetentionDays(),
    batchSize: getMaintenanceBatchSize(),
  };
}

async function inspectStaleJobs({ now, policy, execute }) {
  const db = getFirebaseDb();
  const oldestActionableDate = new Date(now.getTime() - policy.actionableDays * 86400000);
  const snap = await db
    .collectionGroup("facturaJobs")
    .where("updatedAt", "<=", Timestamp.fromDate(oldestActionableDate))
    .limit(policy.batchSize)
    .get();
  const entries = [];

  for (const doc of snap.docs) {
    const data = doc.data();
    const decision = evaluateJobRetention(data, { now, ...policy });

    if (decision.action === RETENTION_ACTIONS.KEEP) {
      continue;
    }

    const entry = {
      path: doc.ref.path,
      uid: data.uid ?? doc.ref.parent.parent?.id ?? null,
      jobId: data.id ?? doc.id,
      previousStatus: data.status ?? null,
      ...decision,
      executed: false,
    };

    if (execute && decision.action === RETENTION_ACTIONS.EXPIRE_JOB) {
      entry.executed = await expireJobIfStillEligible(doc.ref, { now, policy });
    } else if (execute && decision.action === RETENTION_ACTIONS.PURGE_JOB) {
      entry.executed = await purgeJobIfStillEligible(doc.ref, { now, policy });
    }

    entries.push(entry);
  }

  return summarizeEntries(entries, snap.size, policy.batchSize);
}

async function expireJobIfStillEligible(ref, { now, policy }) {
  const db = getFirebaseDb();

  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);

    if (!snap.exists) {
      return false;
    }

    const decision = evaluateJobRetention(snap.data(), { now, ...policy });
    if (decision.action !== RETENTION_ACTIONS.EXPIRE_JOB) {
      return false;
    }

    const patch = buildExpiredJobPatch({ now, actionableDays: policy.actionableDays });
    transaction.update(ref, {
      ...patch,
      expiredAt: Timestamp.fromDate(now),
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.set(ref.collection("events").doc(), {
      type: "expired",
      status: "expired",
      message: patch.statusMessage,
      actor: "maintenance",
      workerId: null,
      attemptCount: snap.data().attemptCount ?? 0,
      metadata: {
        reason: patch.expirationReason,
        actionableDays: policy.actionableDays,
      },
      createdAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
}

async function purgeJobIfStillEligible(ref, { now, policy }) {
  const db = getFirebaseDb();
  const marked = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);

    if (!snap.exists) {
      return false;
    }

    const decision = evaluateJobRetention(snap.data(), { now, ...policy });
    if (decision.action !== RETENTION_ACTIONS.PURGE_JOB) {
      return false;
    }

    transaction.update(ref, {
      maintenancePurgeStartedAt: Timestamp.fromDate(now),
    });
    return true;
  });

  if (!marked) {
    return false;
  }

  await db.recursiveDelete(ref);
  return true;
}

async function inspectStaleCommands({ now, policy, execute }) {
  const db = getFirebaseDb();
  const cutoff = new Date(now.getTime() - policy.actionableDays * 86400000);
  const snap = await db
    .collectionGroup("billingJobCommands")
    .where("requestedAt", "<=", Timestamp.fromDate(cutoff))
    .limit(policy.batchSize)
    .get();
  const entries = [];

  for (const doc of snap.docs) {
    const data = doc.data();
    const decision = evaluateBillingCommandRetention(data, {
      now,
      pendingDays: policy.actionableDays,
      terminalDays: policy.commandDays,
    });

    if (decision.action === RETENTION_ACTIONS.KEEP) {
      continue;
    }

    let executed = false;
    if (execute) {
      executed = await applyCommandRetentionIfStillEligible(doc.ref, { now, policy });
    }

    entries.push({
      path: doc.ref.path,
      commandId: doc.id,
      jobId: data.jobId ?? null,
      previousStatus: data.status ?? null,
      ...decision,
      executed,
    });
  }

  return summarizeEntries(entries, snap.size, policy.batchSize);
}

async function applyCommandRetentionIfStillEligible(ref, { now, policy }) {
  const db = getFirebaseDb();

  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);

    if (!snap.exists) {
      return false;
    }

    const decision = evaluateBillingCommandRetention(snap.data(), {
      now,
      pendingDays: policy.actionableDays,
      terminalDays: policy.commandDays,
    });

    if (decision.action === RETENTION_ACTIONS.EXPIRE_COMMAND) {
      transaction.update(ref, {
        status: "rejected",
        result: {
          reason: "command_expired",
          message: "El comando caducó antes de ser procesado.",
        },
        processedAt: Timestamp.fromDate(now),
      });
      return true;
    }

    if (decision.action === RETENTION_ACTIONS.DELETE_COMMAND) {
      transaction.delete(ref);
      return true;
    }

    return false;
  });
}

async function inspectInactiveTemplateCandidates({ now, policy, execute }) {
  const db = getFirebaseDb();
  const { collection, document } = getFirestoreRoot();
  const snap = await db
    .collection(collection)
    .doc(document)
    .collection("billingPortalTemplates")
    .where("activeForRouting", "==", false)
    .limit(policy.batchSize)
    .get();
  const entries = [];

  for (const doc of snap.docs) {
    const data = doc.data();
    const decision = evaluateTemplateCandidateRetention(data, {
      now,
      inactiveDays: policy.inactiveTemplateDays,
    });

    if (decision.action !== RETENTION_ACTIONS.DELETE_REGISTRY_CANDIDATE) {
      continue;
    }

    let executed = false;
    if (execute) {
      executed = await deleteTemplateCandidateIfStillEligible(doc.ref, { now, policy });
    }

    entries.push({
      path: doc.ref.path,
      templateId: data.templateId ?? data.candidate?.template?.id ?? null,
      rfcEmisor: data.rfcEmisor ?? data.candidate?.template?.rfcEmisor ?? null,
      previousStatus: data.status ?? data.candidate?.status ?? null,
      ...decision,
      executed,
    });
  }

  return summarizeEntries(entries, snap.size, policy.batchSize);
}

async function deleteTemplateCandidateIfStillEligible(ref, { now, policy }) {
  const db = getFirebaseDb();

  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);

    if (!snap.exists) {
      return false;
    }

    const decision = evaluateTemplateCandidateRetention(snap.data(), {
      now,
      inactiveDays: policy.inactiveTemplateDays,
    });
    if (decision.action !== RETENTION_ACTIONS.DELETE_REGISTRY_CANDIDATE) {
      return false;
    }

    transaction.delete(ref);
    return true;
  });
}

async function inspectStaleStorage({ now, policy, execute }) {
  const bucket = getFirebaseStorageBucket();
  const prefixes = ["billing-lab/tickets/", "billing-lab/portal-artifacts/"];
  const entries = [];
  let inspected = 0;

  for (const prefix of prefixes) {
    if (inspected >= policy.batchSize) {
      break;
    }

    const [files] = await bucket.getFiles({
      prefix,
      maxResults: policy.batchSize - inspected,
      autoPaginate: false,
    });

    for (const file of files) {
      inspected += 1;
      const [metadata] = await file.getMetadata();
      const decision = evaluateStorageObjectRetention(
        {
          name: file.name,
          updatedAt: metadata.updated ?? metadata.timeCreated,
        },
        { now, ...policy },
      );

      if (decision.action !== RETENTION_ACTIONS.DELETE_STORAGE_OBJECT) {
        continue;
      }

      let executed = false;
      if (execute) {
        await file.delete({ ignoreNotFound: true });
        executed = true;
      }

      entries.push({
        bucket: bucket.name,
        name: file.name,
        ...decision,
        executed,
      });
    }
  }

  return summarizeEntries(entries, inspected, policy.batchSize);
}

function summarizeEntries(entries, inspected, batchSize) {
  return {
    inspected,
    candidates: entries.length,
    executed: entries.filter((entry) => entry.executed).length,
    batchSize,
    truncated: inspected >= batchSize,
    entries,
  };
}
