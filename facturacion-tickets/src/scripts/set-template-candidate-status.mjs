import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validatePortalTemplate } from "../portals/template-schema.mjs";

const allowedStatuses = new Set([
  "draft",
  "candidate_cached",
  "compiled",
  "replay_passed_1",
  "degraded",
  "blocked",
  "active_lab",
  "active",
  "rejected",
]);
const file = getCliOption("file");
const templateId = getCliOption("template-id");
const status = getCliOption("status");
const reason = getCliOption("reason") ?? null;
const directory = resolve("data/portal-template-candidates");

if (!allowedStatuses.has(status)) {
  throw new Error(`Missing or invalid --status. Use one of: ${[...allowedStatuses].join(", ")}`);
}

const candidatePath = await resolveCandidatePath({ file, templateId });

if (!candidatePath) {
  throw new Error("Missing candidate selector. Use --file=NAME.candidate.json or --template-id=ID");
}

const document = JSON.parse(await readFile(candidatePath, "utf8"));
const validation = validatePortalTemplate(document.template ?? {});

if (["active", "active_lab"].includes(status) && !validation.ok) {
  throw new Error(`Cannot mark invalid template as ${status}: ${validation.errors.join("; ")}`);
}

const previousStatus = document.status ?? null;
const updated = {
  ...document,
  status,
  validation,
  review: {
    ...(document.review ?? {}),
    previousStatus,
    status,
    reason,
    reviewedAt: new Date().toISOString(),
  },
};

await writeFile(candidatePath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      path: candidatePath,
      templateId: updated.template?.id ?? null,
      previousStatus,
      status,
      validation,
    },
    null,
    2,
  ),
);

async function resolveCandidatePath({ file, templateId }) {
  if (file) {
    const normalizedFile = file.endsWith(".candidate.json") ? file : `${file}.candidate.json`;
    return resolve(directory, normalizedFile);
  }

  if (!templateId) {
    return null;
  }

  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".candidate.json")) {
      continue;
    }

    const path = resolve(directory, entry.name);
    const raw = JSON.parse(await readFile(path, "utf8"));

    if (raw.template?.id === templateId) {
      return path;
    }
  }

  throw new Error(`Candidate not found for template id ${templateId}`);
}

function getCliOption(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}
