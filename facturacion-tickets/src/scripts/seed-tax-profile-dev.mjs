import { FieldValue } from "firebase-admin/firestore";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getCliOption, getFirestoreRoot } from "../config/env.mjs";
import { getFirebaseDb } from "../config/firebase.mjs";

const uid = getCliOption("uid");
const profilePath = getCliOption("profile") ?? "data/tax-profiles/sample.json";
const jobId = getCliOption("job-id");
const queueJob = getCliOption("queue-job") !== "false";

if (!uid) {
  throw new Error("Missing required --uid=UID_DEL_LAB");
}

const db = getFirebaseDb();
const { collection, document } = getFirestoreRoot();
const profile = normalizeTaxProfile(JSON.parse(await readFile(resolve(profilePath), "utf8")));
const userRef = db.collection(collection).doc(document).collection("users").doc(uid);
const profileRef = userRef.collection("contribuyentes").doc(profile.id);

await profileRef.set(buildContribuyenteDoc(uid, profile), { merge: true });

const result = {
  uid,
  profileId: profile.id,
  profilePath,
  rfc: profile.rfc,
  jobUpdated: null,
};

if (jobId) {
  const jobRef = userRef.collection("facturaJobs").doc(jobId);
  const jobSnap = await jobRef.get();

  if (!jobSnap.exists) {
    throw new Error(`Job not found: users/${uid}/facturaJobs/${jobId}`);
  }

  await jobRef.update({
    taxProfileId: profile.id,
    taxProfile: profile.taxProfile,
    rfcReceptor: profile.taxProfile.rfc,
    ...(queueJob
      ? {
          status: "pending",
          statusMessage: "Perfil fiscal cargado; listo para reprocesar",
          error: null,
          lastError: null,
          missingFields: [],
          attemptCount: 0,
          claimedBy: null,
          leaseExpiresAt: null,
          retryAt: null,
        }
      : {}),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await jobRef.collection("events").add({
    type: "tax_profile_seeded",
    status: queueJob ? "pending" : jobSnap.data().status ?? null,
    message: "Perfil fiscal de prueba cargado desde CSF",
    actor: "seed",
    workerId: null,
    attemptCount: null,
    metadata: {
      taxProfileId: profile.id,
      rfc: profile.taxProfile.rfc,
      queued: queueJob,
    },
    createdAt: FieldValue.serverTimestamp(),
  });

  result.jobUpdated = {
    jobId,
    queued: queueJob,
  };
}

console.log(JSON.stringify(result, null, 2));

function normalizeTaxProfile(profile) {
  const taxProfile = {
    rfc: clean(profile.rfc).toUpperCase(),
    legalName: clean(profile.legalName),
    email: clean(profile.email),
    fiscalRegime: clean(profile.fiscalRegime),
    cfdiUse: clean(profile.cfdiUse),
    postalCode: clean(profile.postalCode),
    street: clean(profile.street),
    exteriorNumber: clean(profile.exteriorNumber),
    interiorNumber: clean(profile.interiorNumber),
    neighborhood: clean(profile.neighborhood),
    municipality: clean(profile.municipality),
    state: clean(profile.state),
    country: clean(profile.country) || "MEXICO",
  };

  for (const [key, value] of Object.entries(taxProfile)) {
    if (key === "interiorNumber" || key === "email") {
      continue;
    }

    if (!value) {
      throw new Error(`Tax profile is missing ${key}`);
    }
  }

  return {
    ...profile,
    id: clean(profile.id) || "billing_lab_default",
    taxProfile,
  };
}

function buildContribuyenteDoc(uid, profile) {
  const taxProfile = profile.taxProfile;
  const domicilio = [
    taxProfile.street,
    taxProfile.exteriorNumber,
    taxProfile.interiorNumber,
    taxProfile.neighborhood,
    taxProfile.municipality,
    taxProfile.state,
    taxProfile.postalCode,
  ]
    .filter(Boolean)
    .join(", ");

  return {
    uid,
    tipo: taxProfile.rfc.length === 12 ? "moral" : "fisica",
    rfc: taxProfile.rfc,
    nombre: taxProfile.legalName,
    regimenesFiscales: [taxProfile.fiscalRegime],
    obligaciones: [],
    domicilioFiscal: domicilio,
    estatus: "Activo",
    email: taxProfile.email,
    usoCfdi: taxProfile.cfdiUse,
    codigoPostal: taxProfile.postalCode,
    calle: taxProfile.street,
    ext: taxProfile.exteriorNumber,
    int: taxProfile.interiorNumber,
    colonia: taxProfile.neighborhood,
    municipio: taxProfile.municipality,
    estado: taxProfile.state,
    pais: taxProfile.country,
    taxProfile,
    source: profile.source ?? "manual",
    sourceFile: profile.sourceFile ?? null,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function clean(value) {
  return String(value ?? "").trim();
}
