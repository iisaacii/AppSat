import { GoogleAuth } from "google-auth-library";
import { getEnv } from "../config/env.mjs";

const projectId = getEnv("FIREBASE_PROJECT_ID", "appsat-dev");
const rulesApi = "https://firebaserules.googleapis.com/v1";
const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
const client = await auth.getClient();
const token = await client.getAccessToken();

async function getJson(url) {
  const response = await fetch(url, {
    method: "GET",
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

try {
  console.log("Fetching releases...");
  const releases = await getJson(`${rulesApi}/projects/${projectId}/releases`);
  console.log("Releases:\n", JSON.stringify(releases, null, 2));

  for (const release of (releases.releases || [])) {
    if (release.rulesetName) {
      console.log(`\nFetching ruleset details for ${release.name} (${release.rulesetName})...`);
      const ruleset = await getJson(`${rulesApi}/${release.rulesetName}`);
      console.log(`Ruleset files:`);
      for (const file of (ruleset.source?.files || [])) {
        console.log(`--- File: ${file.name} ---`);
        console.log(file.content);
      }
    }
  }
} catch (error) {
  console.error("Error:", error);
}
