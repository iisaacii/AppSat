import { FieldValue } from "firebase-admin/firestore";
import { getFirestoreRoot } from "../config/env.mjs";
import { getFirebaseDb } from "../config/firebase.mjs";
import { extractFields } from "../ocr/google-vision-ocr.service.mjs";
import { findPortalTemplateByRfc } from "../portals/portal-registry.mjs";
import { resolveTemplateFields } from "../portals/template-fields.mjs";

const db = getFirebaseDb();
const jobDoc = await findLatestGoogleVisionJob(db);

if (!jobDoc) {
  console.log("No google_vision job with ocrTextPreview found.");
  process.exit(0);
}

const data = jobDoc.data();
const extracted = extractFields(data.ocrTextPreview);
const template = await findPortalTemplateByRfc(extracted.rfcEmisor);
const fieldResolution = template
  ? resolveTemplateFields(template, {
      ...data,
      ...extracted,
    })
  : { requiredFields: [], missingFields: [], resolved: {} };

await jobDoc.ref.update({
  ...extracted,
  extractedData: {
    rfcEmisor: extracted.rfcEmisor ?? null,
    folio: extracted.folio ?? null,
    fecha: extracted.fecha ?? null,
    monto: extracted.monto ?? null,
    ocrEngine: data.ocrEngine ?? "google_vision",
    ocrConfidence: extracted.ocrConfidence ?? null,
    ocrCandidates: extracted.ocrCandidates ?? null,
  },
  portalTemplateId: template?.id ?? null,
  portalName: template?.name ?? null,
  portalUrl: template?.portalUrl ?? null,
  requiredFields: fieldResolution.requiredFields,
  missingFields: fieldResolution.missingFields,
  status: template && !fieldResolution.missingFields.length ? "completed" : "needs_user_action",
  statusMessage: buildStatusMessage(template, fieldResolution.missingFields),
  updatedAt: FieldValue.serverTimestamp(),
});

console.log(
  JSON.stringify(
    {
      path: jobDoc.ref.path,
      ...extracted,
      requiredFields: fieldResolution.requiredFields,
      missingFields: fieldResolution.missingFields,
      hasTemplate: Boolean(template),
    },
    null,
    2,
  ),
);

async function findLatestGoogleVisionJob(db) {
  const { collection, document } = getFirestoreRoot();
  const users = await db.collection(collection).doc(document).collection("users").listDocuments();
  const jobs = [];

  for (const userRef of users) {
    const snap = await userRef
      .collection("facturaJobs")
      .orderBy("updatedAt", "desc")
      .limit(10)
      .get();

    for (const doc of snap.docs) {
      const data = doc.data();

      if (data.ocrEngine === "google_vision" && data.ocrTextPreview) {
        jobs.push({
          doc,
          updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() ?? "",
        });
      }
    }
  }

  jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return jobs[0]?.doc ?? null;
}

function buildStatusMessage(template, missingFields) {
  if (!template) {
    return "OCR reparseado; no hay portal automatizado para este emisor";
  }

  if (missingFields.length) {
    return "OCR reparseado; faltan datos para facturar en este portal";
  }

  return "OCR reparseado; portal automatizado encontrado";
}
