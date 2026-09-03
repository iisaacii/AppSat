import { Timestamp } from "firebase-admin/firestore";
import { getFirestoreRoot } from "../config/env.mjs";
import { getFirebaseDb } from "../config/firebase.mjs";

const db = getFirebaseDb();
const { collection, document } = getFirestoreRoot();
const probeValue = "__easysat_index_probe__";
const probeDocumentId = "easysat_index_probe";
const usersRef = db.collection(collection).doc(document).collection("users");
const supportProbe = await findSupportProbeUser(usersRef);
const probes = [
  {
    name: "facturaJobs.id",
    query: () =>
      db.collectionGroup("facturaJobs").where("id", "==", probeValue).limit(1).get(),
  },
  {
    name: "facturaJobs.status_workflowStage",
    query: () =>
      db
        .collectionGroup("facturaJobs")
        .where("status", "==", probeValue)
        .where("workflowStage", "==", probeValue)
        .limit(1)
        .get(),
  },
  {
    name: "facturaJobs.rfcReceptor_createdAt",
    query: () =>
      db
        .collectionGroup("facturaJobs")
        .where("rfcReceptor", "==", probeValue)
        .orderBy("createdAt", "desc")
        .limit(1)
        .get(),
  },
  {
    name: "facturaJobs.updatedAt",
    query: () =>
      db
        .collectionGroup("facturaJobs")
        .where("updatedAt", "<=", Timestamp.fromMillis(0))
        .limit(1)
        .get(),
  },
  {
    name: "facturaJobs.updatedAt_collection_desc",
    query: () =>
      db
        .collection(collection)
        .doc(document)
        .collection("users")
        .doc(supportProbe.documentId)
        .collection("facturaJobs")
        .orderBy("updatedAt", "desc")
        .limit(1)
        .get(),
  },
  {
    name: "billingJobCommands.status",
    query: () =>
      db
        .collectionGroup("billingJobCommands")
        .where("status", "==", probeValue)
        .limit(1)
        .get(),
  },
  {
    name: "billingJobCommands.requestedAt",
    query: () =>
      db
        .collectionGroup("billingJobCommands")
        .where("requestedAt", "<=", Timestamp.fromMillis(0))
        .limit(1)
        .get(),
  },
];

const results = [];
for (const probe of probes) {
  const snap = await probe.query();
  results.push({ name: probe.name, ready: true, matchedDocuments: snap.size });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      mode: "read_only",
      projectId: process.env.FIREBASE_PROJECT_ID ?? null,
      supportQueryUsedExistingCollection: supportProbe.existingCollection,
      probes: results,
    },
    null,
    2,
  ),
);

async function findSupportProbeUser(collectionRef) {
  const userRefs = await collectionRef.listDocuments();
  for (const userRef of userRefs) {
    const jobs = await userRef.collection("facturaJobs").limit(1).get();
    if (!jobs.empty) {
      return { documentId: userRef.id, existingCollection: true };
    }
  }

  return { documentId: probeDocumentId, existingCollection: false };
}
