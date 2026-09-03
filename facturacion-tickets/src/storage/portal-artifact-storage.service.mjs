import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { getCfdiStorageMode, getPortalArtifactStoragePrefix } from "../config/env.mjs";
import { getFirebaseStorageBucket } from "../config/firebase.mjs";
import { logger } from "../shared/logger.mjs";

export async function materializePortalArtifacts({ job, templateResult }) {
  const artifacts = templateResult?.artifacts;

  if (!artifacts || getCfdiStorageMode() !== "firebase") {
    return templateResult;
  }

  const bucket = getFirebaseStorageBucket();
  const basePath = buildBasePath(job);
  const uploads = {};

  if (artifacts.screenshotPath) {
    const upload = await uploadPortalArtifact(bucket, {
      path: `${basePath}/${safeFileName(artifacts.screenshotPath, "screenshot.png")}`,
      localPath: artifacts.screenshotPath,
      contentType: "image/png",
    });
    uploads.screenshotStoragePath = upload.path;
    uploads.screenshotUrl = upload.downloadUrl;
  }

  if (artifacts.htmlPath) {
    const upload = await uploadPortalArtifact(bucket, {
      path: `${basePath}/${safeFileName(artifacts.htmlPath, "page.html")}`,
      localPath: artifacts.htmlPath,
      contentType: "text/html; charset=utf-8",
    });
    uploads.htmlStoragePath = upload.path;
    uploads.htmlUrl = upload.downloadUrl;
  }

  if (!Object.keys(uploads).length) {
    return templateResult;
  }

  logger.info("Portal artifacts stored.", {
    jobId: job.id,
    bucket: bucket.name,
    screenshotPath: uploads.screenshotStoragePath ?? null,
    htmlPath: uploads.htmlStoragePath ?? null,
  });

  return {
    ...templateResult,
    artifacts: {
      ...artifacts,
      ...uploads,
      artifactStorageBucket: bucket.name,
      artifactStorageMode: "firebase",
      artifactStoredAt: new Date().toISOString(),
    },
  };
}

function buildBasePath(job) {
  const uid = sanitizePathSegment(job.uid ?? "unknown_user");
  const jobId = sanitizePathSegment(job.id);
  return `${getPortalArtifactStoragePrefix()}/${uid}/${jobId}`;
}

async function uploadPortalArtifact(bucket, artifact) {
  const token = randomUUID();
  const file = bucket.file(artifact.path);

  await file.save(await readFile(resolve(artifact.localPath)), {
    resumable: false,
    metadata: {
      contentType: artifact.contentType,
      metadata: {
        firebaseStorageDownloadTokens: token,
        appsatSourcePath: artifact.localPath,
      },
    },
  });

  return {
    path: artifact.path,
    downloadUrl: buildFirebaseDownloadUrl(bucket.name, artifact.path, token),
  };
}

function safeFileName(path, fallback) {
  const name = basename(String(path ?? fallback));
  return sanitizePathSegment(name || fallback);
}

function sanitizePathSegment(value) {
  return String(value ?? "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function buildFirebaseDownloadUrl(bucketName, path, token) {
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(
    path,
  )}?alt=media&token=${token}`;
}
