import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { FieldValue } from "firebase-admin/firestore";
import {
  getPortalKnowledgeReadLimit,
  getPortalKnowledgeStoreMode,
  getFirestoreRoot,
} from "../config/env.mjs";
import { getFirebaseDb } from "../config/firebase.mjs";

const TEMPLATE_COLLECTION = "billingPortalTemplates";
const OUTCOME_COLLECTION = "billingPortalOutcomes";

export function shouldReadLocalPortalKnowledge() {
  return getPortalKnowledgeStoreMode() !== "firestore";
}

export function shouldUseSharedPortalKnowledge() {
  return getPortalKnowledgeStoreMode() !== "local";
}

export function buildPortalKnowledgeDocumentId(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 40);
}

export async function publishSharedTemplateCandidate({ document, sourcePath = null } = {}) {
  if (!shouldUseSharedPortalKnowledge() || !document?.template) {
    return null;
  }

  const db = getFirebaseDb();
  const candidateKey = buildTemplateCandidateKey(document, sourcePath);
  const ref = getKnowledgeCollection(db, TEMPLATE_COLLECTION).doc(buildPortalKnowledgeDocumentId(candidateKey));
  const now = new Date().toISOString();
  const candidate = removeUndefinedDeep(document);
  const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");

  if (candidateBytes > 900 * 1024) {
    throw new Error(`Shared template candidate exceeds safe Firestore size (${candidateBytes} bytes).`);
  }

  const record = removeUndefinedDeep({
    schemaVersion: "portal-knowledge.v1",
    kind: "template_candidate",
    candidateKey,
    rfcEmisor: normalizeRfc(document.template.rfcEmisor),
    portalHost: hostFromUrl(document.template.portalUrl),
    templateId: document.template.id ?? null,
    status: document.status ?? "draft",
    activeForRouting: ["active", "active_lab"].includes(document.status),
    sourceCreatedAt: document.source?.createdAt ?? now,
    sourcePath: sourcePath ? normalizePath(sourcePath) : null,
    candidateBytes,
    candidate,
    updatedAt: FieldValue.serverTimestamp(),
  });

  await ref.set(record, { merge: true });

  return {
    id: ref.id,
    path: ref.path,
    candidateKey,
    status: record.status,
  };
}

export async function listSharedTemplateCandidates({ rfcEmisor = null, templateId = null } = {}) {
  if (!shouldUseSharedPortalKnowledge()) {
    return [];
  }

  const db = getFirebaseDb();
  let query = getKnowledgeCollection(db, TEMPLATE_COLLECTION);

  if (rfcEmisor) {
    query = query.where("rfcEmisor", "==", normalizeRfc(rfcEmisor));
  } else if (templateId) {
    query = query.where("templateId", "==", String(templateId));
  }

  const snap = await query.limit(getPortalKnowledgeReadLimit()).get();

  return snap.docs
    .map((doc) => ({
      id: doc.id,
      path: doc.ref.path,
      ...doc.data(),
    }))
    .filter((record) => record.kind === "template_candidate" && record.candidate?.template)
    .sort((left, right) => String(right.sourceCreatedAt ?? "").localeCompare(String(left.sourceCreatedAt ?? "")));
}

export async function degradeSharedTemplateCandidate({ templateId, reason = "template_runtime_error" } = {}) {
  if (!shouldUseSharedPortalKnowledge() || !templateId) {
    return 0;
  }

  const records = await listSharedTemplateCandidates({ templateId });
  const active = records.filter((record) => ["active", "active_lab"].includes(record.status));

  if (!active.length) {
    return 0;
  }

  const db = getFirebaseDb();
  const batch = db.batch();
  const reviewedAt = new Date().toISOString();

  for (const record of active) {
    const candidate = {
      ...record.candidate,
      status: "degraded",
      review: {
        ...(record.candidate.review ?? {}),
        previousStatus: record.status,
        status: "degraded",
        reason,
        reviewedAt,
      },
    };
    batch.set(
      db.doc(record.path),
      removeUndefinedDeep({
        status: "degraded",
        activeForRouting: false,
        candidate,
        updatedAt: FieldValue.serverTimestamp(),
      }),
      { merge: true },
    );
  }

  await batch.commit();
  return active.length;
}

export async function listSharedPortalOutcomes({ rfcEmisor, portalHost = null } = {}) {
  if (!shouldUseSharedPortalKnowledge() || !normalizeRfc(rfcEmisor)) {
    return [];
  }

  const db = getFirebaseDb();
  const snap = await getKnowledgeCollection(db, OUTCOME_COLLECTION)
    .where("rfcEmisor", "==", normalizeRfc(rfcEmisor))
    .limit(getPortalKnowledgeReadLimit())
    .get();

  return snap.docs
    .map((doc) => ({ id: doc.id, path: doc.ref.path, ...doc.data() }))
    .filter((entry) => !portalHost || !entry.portalHost || entry.portalHost === portalHost)
    .sort((left, right) => String(right.lastSeenAt ?? "").localeCompare(String(left.lastSeenAt ?? "")));
}

export async function rememberSharedPortalOutcome({
  rfcEmisor,
  portalUrl = null,
  reason,
  status = null,
  statusMessage = null,
  source = "orchestrator",
  templateId = null,
  portalFamily = null,
  metadata = null,
} = {}) {
  if (!shouldUseSharedPortalKnowledge()) {
    return null;
  }

  const rfc = normalizeRfc(rfcEmisor);
  const portalHost = hostFromUrl(portalUrl);
  const key = [rfc, portalHost ?? "unknown-host", String(reason ?? "")].join("|");
  const db = getFirebaseDb();
  const ref = getKnowledgeCollection(db, OUTCOME_COLLECTION).doc(buildPortalKnowledgeDocumentId(key));

  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const previous = snap.exists ? snap.data() : {};
    const now = new Date().toISOString();
    const succeeded = status === "completed" || status === "resolved";
    const entry = removeUndefinedDeep({
      schemaVersion: "portal-knowledge.v1",
      kind: "portal_outcome",
      key,
      rfcEmisor: rfc,
      portalHost,
      portalUrl: portalUrl ?? previous.portalUrl ?? null,
      reason,
      lastStatus: status ?? previous.lastStatus ?? null,
      statusMessage: statusMessage ?? previous.statusMessage ?? null,
      source,
      templateId: templateId ?? previous.templateId ?? null,
      portalFamily: portalFamily ?? previous.portalFamily ?? null,
      failureCount: succeeded ? Number(previous.failureCount ?? 0) : Number(previous.failureCount ?? 0) + 1,
      successCount: succeeded ? Number(previous.successCount ?? 0) + 1 : Number(previous.successCount ?? 0),
      firstSeenAt: previous.firstSeenAt ?? now,
      lastSeenAt: now,
      metadata: {
        ...(previous.metadata ?? {}),
        ...(metadata ?? {}),
      },
      updatedAt: FieldValue.serverTimestamp(),
    });

    transaction.set(ref, entry, { merge: false });
    return entry;
  });
}

function getKnowledgeCollection(db, name) {
  const { collection, document } = getFirestoreRoot();
  return db.collection(collection).doc(document).collection(name);
}

function buildTemplateCandidateKey(document, sourcePath) {
  return [
    sourcePath ? normalizePath(sourcePath) : "generated",
    document.template?.id ?? "unknown-template",
    document.source?.createdAt ?? "unknown-created-at",
  ].join("|");
}

function normalizeRfc(value) {
  return String(value ?? "").trim().toUpperCase();
}

function hostFromUrl(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function normalizePath(value) {
  const raw = String(value ?? "");
  const normalized = isAbsolute(raw) ? relative(process.cwd(), raw) : raw;
  return normalized.replaceAll("\\", "/");
}

function removeUndefinedDeep(value) {
  if (Array.isArray(value)) {
    return value.map(removeUndefinedDeep);
  }

  if (value && typeof value === "object" && !(value instanceof Date) && value.constructor === Object) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, removeUndefinedDeep(entry)]),
    );
  }

  return value;
}
