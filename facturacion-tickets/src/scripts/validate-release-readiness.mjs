import { spawnSync } from "node:child_process";

const live = process.argv.includes("--live");
const security = process.argv.includes("--security");
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const checks = [
  "firestore:indexes:validate",
  "contract:validate",
  "api:validate",
  "api:v2:validate",
  "ocr:autonomous:validate",
  "worker:workflow:validate",
  "portal:outcome:validate",
  "user-action:validate",
  "url:security:validate",
  "queue:health:validate",
  "b3:usage:validate",
  "compiler:gpt:validate",
  "b3:a-bridge:validate",
  "monitoring:policies:validate",
  "retention:validate",
  "cfdi:validate",
  "deployment:infrastructure:validate",
  "gemini:backend:validate",
  "deployment:cloud-run:validate",
];

if (security) {
  checks.push("security:rules:validate");
}
if (live) {
  checks.push("firestore:indexes:probe", "maintenance:retention:summary");
}

const completed = [];
for (const script of checks) {
  console.log(`\n=== release preflight: ${script} ===`);
  const result = spawnSync(npmExecutable, ["run", script], {
    cwd: process.cwd(),
    env: { ...process.env, NO_UPDATE_NOTIFIER: "1" },
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Release preflight failed at ${script} with exit code ${result.status}`);
  }
  completed.push(script);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      mode: live ? "live_read_only" : "local",
      securityEmulators: security,
      completed,
    },
    null,
    2,
  ),
);
