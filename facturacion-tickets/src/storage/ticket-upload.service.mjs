import { createHash, randomUUID } from "node:crypto";
import { getFirebaseStorageBucket } from "../config/firebase.mjs";
import { buildBillingApiResourceId } from "../api/billing-api-repository.mjs";
import { conflict } from "../api/api-error.mjs";

const extensions = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
};

export function createFirebaseTicketUploadService({ bucket = getFirebaseStorageBucket() } = {}) {
  return {
    save: (input) => saveTicketUpload(bucket, input),
  };
}

async function saveTicketUpload(bucket, { uid, ticket, idempotencyKey }) {
  const resourceId = buildBillingApiResourceId("ticket", uid, idempotencyKey);
  const extension = extensions[ticket.mimeType] ?? "img";
  const path = `billing-api/tickets/${sanitize(uid)}/${resourceId}.${extension}`;
  const file = bucket.file(path);
  const contentHash = sha256(ticket.buffer);
  const [exists] = await file.exists();

  if (exists) {
    const [metadata] = await file.getMetadata();
    const storedHash = metadata.metadata?.appsatContentSha256;
    if (storedHash && storedHash !== contentHash) {
      throw conflict(
        "idempotency_conflict",
        "La clave de idempotencia ya fue utilizada con otra imagen",
      );
    }
    const token = firstToken(metadata.metadata?.firebaseStorageDownloadTokens);
    if (token) {
      return {
        path,
        downloadUrl: buildFirebaseDownloadUrl(bucket.name, path, token),
        reused: true,
      };
    }
  }

  const token = randomUUID();
  await file.save(ticket.buffer, {
    resumable: false,
    metadata: {
      contentType: ticket.mimeType,
      cacheControl: "private, max-age=0, no-store",
      metadata: {
        firebaseStorageDownloadTokens: token,
        appsatContentSha256: contentHash,
        appsatOriginalFilename: sanitizeMetadata(ticket.filename),
        appsatSource: "billing_api_v2",
      },
    },
  });

  return {
    path,
    downloadUrl: buildFirebaseDownloadUrl(bucket.name, path, token),
    reused: false,
  };
}

function buildFirebaseDownloadUrl(bucketName, path, token) {
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

function firstToken(value) {
  return String(value ?? "").split(",").map((entry) => entry.trim()).find(Boolean) ?? null;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sanitize(value) {
  return String(value ?? "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
}

function sanitizeMetadata(value) {
  return String(value ?? "ticket").replace(/[\r\n\0]/g, "").slice(0, 180);
}
