import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleAuth } from "google-auth-library";
import { getEnv } from "../config/env.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceDir = resolve(rootDir, "..");
const rulesPath = resolve(workspaceDir, "firestore.rules");
const projectId = getEnv("FIREBASE_PROJECT_ID", "easysat-dev");
const rulesApi = "https://firebaserules.googleapis.com/v1";
const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
const client = await auth.getClient();
const token = await client.getAccessToken();
const rulesContent = await readFile(rulesPath, "utf8");

const ruleset = await postJson(`${rulesApi}/projects/${projectId}/rulesets`, {
  source: {
    files: [
      {
        name: "firestore.rules",
        content: rulesContent,
      },
    ],
  },
});

const releaseName = `projects/${projectId}/releases/cloud.firestore`;
const release = await patchJson(`${rulesApi}/${releaseName}`, {
  release: {
    name: releaseName,
    rulesetName: ruleset.name,
  },
  updateMask: "ruleset_name",
});

console.log(
  JSON.stringify(
    {
      projectId,
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
