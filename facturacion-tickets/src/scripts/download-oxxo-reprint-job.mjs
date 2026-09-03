import { getFirestoreRoot } from "../config/env.mjs";
import { getFirebaseDb } from "../config/firebase.mjs";
import { appendFirestoreJobEvent, updateFirestoreJob } from "../jobs/firestore-job-store.mjs";
import { recoverOxxoCfdiByReprint, resolveOxxoReprintTicket } from "../portals/recovery/oxxo-reprint-recovery.mjs";
import { materializeCfdiResult } from "../storage/cfdi-storage.service.mjs";

const uid = getArg("uid") ?? process.env.FIRESTORE_WORKER_UID;
const jobId = getArg("job-id") ?? getArg("jobId");

if (!uid || !jobId) {
  throw new Error("Uso: node src/scripts/download-oxxo-reprint-job.mjs --uid=<uid> --job-id=<jobId>");
}

const job = await readJob(uid, jobId);
const ticket = resolveOxxoReprintTicket(job);
const template = { id: job.portalTemplateId ?? "oxxo-demo", rfcEmisor: job.rfcEmisor ?? "CCO8605231N4" };
const templateResult = await recoverOxxoCfdiByReprint({ job, template, context: ticket });
const cfdiResult = await storeAndCompleteJob({ job, ticket, templateResult });

console.log(
  JSON.stringify(
    {
      ok: true,
      jobId,
      uid,
      ticket,
      downloads: {
        xmlPath: templateResult.xmlPath,
        pdfPath: templateResult.pdfPath,
        xmlDownloadFileName: templateResult.xmlDownloadFileName,
        pdfDownloadFileName: templateResult.pdfDownloadFileName,
      },
      artifacts: templateResult.artifacts,
      cfdi: cfdiResult,
    },
    null,
    2,
  ),
);

function getArg(name) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function readJob(uidValue, id) {
  const db = getFirebaseDb();
  const { collection, document } = getFirestoreRoot();
  const ref = db
    .collection(collection)
    .doc(document)
    .collection("users")
    .doc(uidValue)
    .collection("facturaJobs")
    .doc(id);
  const snap = await ref.get();

  if (!snap.exists) {
    throw new Error(`Firestore job no encontrado: ${ref.path}`);
  }

  return {
    ...snap.data(),
    id,
    uid: uidValue,
    _firestorePath: ref.path,
  };
}

async function storeAndCompleteJob({ job, ticket, templateResult }) {
  const cfdiResult = await materializeCfdiResult({
    job,
    template: { id: job.portalTemplateId ?? "oxxo-demo", rfcEmisor: job.rfcEmisor ?? "CCO8605231N4" },
    templateResult,
    extracted: {
      folio: ticket.folio,
      fecha: job.fecha ?? ticket.fecha,
      monto: Number(ticket.monto),
    },
  });
  const portalRunResult = {
    status: "completed",
    statusMessage: "OXXO factura descargada desde reimpresion",
    reason: "cfdi_downloaded_from_reprint",
    templateId: job.portalTemplateId ?? "oxxo-demo",
    jobId: job.id,
    artifacts: templateResult.artifacts,
    xmlUrl: cfdiResult.resultXmlUrl,
    pdfUrl: cfdiResult.resultPdfUrl,
    downloadMode: "oxxo_reprint",
  };

  await updateFirestoreJob(job.id, {
    ...cfdiResult,
    portalRunResult,
    status: "completed",
    statusMessage: "Factura OXXO emitida, descargada y guardada",
    error: null,
    claimedBy: null,
    leaseExpiresAt: null,
    retryAt: null,
  });

  await appendFirestoreJobEvent(job.id, {
    type: "cfdi_stored",
    status: "completed",
    message: "CFDI OXXO descargado por reimpresion y guardado en Firebase Storage",
    actor: "worker",
    metadata: {
      downloadMode: "oxxo_reprint",
      resultXmlStoragePath: cfdiResult.resultXmlStoragePath ?? null,
      resultPdfStoragePath: cfdiResult.resultPdfStoragePath ?? null,
    },
  });

  return cfdiResult;
}
