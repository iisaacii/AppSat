import { getFirebaseStorageBucketName } from "../config/env.mjs";
import {
  assertTrustedTicketFileUrl,
  downloadExternalResource,
} from "../security/external-url-policy.mjs";

export async function loadTrustedTicketImage(
  ticketFileUrl,
  { uid, maxBytes = 10 * 1024 * 1024, timeoutMs = 30_000 } = {},
) {
  if (!String(ticketFileUrl ?? "").startsWith("http")) {
    throw new Error("El OCR requiere una URL descargable del ticket.");
  }

  assertTrustedTicketFileUrl(ticketFileUrl, {
    uid,
    bucketName: getFirebaseStorageBucketName(),
  });
  const resource = await downloadExternalResource(ticketFileUrl, {
    protocols: ["https:"],
    maxBytes,
    timeoutMs,
  });
  const contentType = resource.contentType.split(";", 1)[0].trim().toLowerCase();

  if (!contentType.startsWith("image/")) {
    throw new Error(`El archivo del ticket no es una imagen valida (${contentType || "sin content-type"}).`);
  }

  return {
    buffer: resource.buffer,
    contentType,
    finalUrl: resource.finalUrl,
  };
}
