import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { getFirebaseStorageBucket } from "../config/firebase.mjs";
import { extractTicketData } from "../ocr/ocr.service.mjs";
import { enrichTicketExtraction } from "../ocr/ticket-enrichment.service.mjs";
import { resolveAutonomousOcr } from "../ocr/autonomous-ocr.service.mjs";

const ticketPath = resolve(getRequiredArg("--ticket"));
const ticketStat = await stat(ticketPath);
if (!ticketStat.isFile() || ticketStat.size < 1 || ticketStat.size > 10 * 1024 * 1024) {
  throw new Error("Ticket image must be a non-empty file up to 10 MiB.");
}

const uid = `autonomous_ocr_smoke_${randomUUID().replaceAll("-", "")}`;
const extension = extname(ticketPath).toLowerCase() || ".jpg";
const objectPath = `billing-api/tickets/${uid}/ticket${extension}`;
const token = randomUUID();
const bucket = getFirebaseStorageBucket();

try {
  await bucket.file(objectPath).save(await readFile(ticketPath), {
    resumable: false,
    metadata: {
      contentType: getImageContentType(ticketPath),
      metadata: { firebaseStorageDownloadTokens: token },
    },
  });
  const ticketFileUrl = buildFirebaseDownloadUrl(bucket.name, objectPath, token);
  const vision = await extractTicketData(ticketFileUrl, { uid });
  const enriched = enrichTicketExtraction(vision);
  const result = await resolveAutonomousOcr({
    job: {
      id: `smoke_${Date.now()}`,
      uid,
      ticketFileUrl,
      processingMode: "autonomous",
      rfcReceptor: "XAXX010101000",
      taxProfile: { rfc: "XAXX010101000" },
    },
    extracted: enriched,
  });

  console.log(JSON.stringify({
    ok: result.resolution.status === "accepted",
    status: result.resolution.status,
    confidence: result.resolution.confidence,
    selected: result.resolution.selected,
    unresolvedFields: result.resolution.unresolvedFields,
    candidateSets: result.resolution.candidateSets,
    providers: result.resolution.providers,
    visionPasses: vision.ocrPasses,
  }, null, 2));
  if (result.resolution.status !== "accepted") process.exitCode = 1;
} finally {
  await bucket.file(objectPath).delete({ ignoreNotFound: true });
}

function buildFirebaseDownloadUrl(bucketName, path, downloadToken) {
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(path)}?alt=media&token=${downloadToken}`;
}

function getImageContentType(path) {
  switch (extname(path).toLowerCase()) {
    case ".png": return "image/png";
    case ".webp": return "image/webp";
    case ".avif": return "image/avif";
    default: return "image/jpeg";
  }
}

function getRequiredArg(name) {
  const value = process.argv.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value) throw new Error(`Missing ${name}=...`);
  return value;
}
