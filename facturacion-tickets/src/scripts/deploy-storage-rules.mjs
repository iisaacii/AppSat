import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleAuth } from "google-auth-library";
import { getEnv } from "../config/env.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceDir = resolve(rootDir, "..");
const rulesPath = resolve(workspaceDir, "storage.rules");
const projectId = getEnv("FIREBASE_PROJECT_ID", "appsat-dev");
const bucketName = getEnv("FIREBASE_STORAGE_BUCKET", "appsat-dev.firebasestorage.app").replace(/^gs:\/\//, "").trim();

const rulesApi = "https://firebaserules.googleapis.com/v1";
const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
const client = await auth.getClient();
const token = await client.getAccessToken();
const rulesContent = await readFile(rulesPath, "utf8");

console.log(`Deploying Storage rules for project: ${projectId}, bucket: ${bucketName}...`);

const ruleset = await postJson(`${rulesApi}/projects/${projectId}/rulesets`, {
  source: {
    files: [
      {
        name: "storage.rules",
        content: rulesContent,
      },
    ],
  },
});

const releaseName = `projects/${projectId}/releases/firebase.storage/${bucketName}`;
const release = await patchJson(`${rulesApi}/${releaseName}`, {
  release: {
    name: releaseName,
    rulesetName: ruleset.name,
  },
  updateMask: "ruleset_name",
});

console.log("Storage rules deployed successfully!");
console.log(
  JSON.stringify(
    {
      projectId,
      bucketName,
      rulesPath,
      rulesetName: ruleset.name,
      releaseName: release.name,
      updateTime: release.updateTime ?? null,
    },
    null,
    2,
  ),
);

async function postJson(url, body) {
  return requestJson(url, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function patchJson(url, body) {
  return requestJson(url, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

async function requestJson(url, init) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token.token ?? token}`,
      "Content-Type": "application/json",
    },
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`Rules API failed ${response.status}: ${JSON.stringify(body)}`);
  }

  return body;
}
