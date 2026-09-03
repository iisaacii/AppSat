import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const directory = resolve("data/portal-template-candidates");
const files = await readdir(directory, { withFileTypes: true }).catch(() => []);
const candidates = [];

for (const entry of files) {
  if (!entry.isFile() || !entry.name.endsWith(".candidate.json")) {
    continue;
  }

  const path = resolve(directory, entry.name);
  const raw = JSON.parse(await readFile(path, "utf8"));
  const template = raw.template ?? {};

  candidates.push({
    file: entry.name,
    status: raw.status ?? null,
    learningState: raw.learningState ?? null,
    validationOk: raw.validation?.ok ?? null,
    createdAt: raw.source?.createdAt ?? null,
    providerMode: raw.source?.providerMode ?? null,
    jobId: raw.source?.jobId ?? null,
    readyForActive: raw.promotion?.readyForActive ?? null,
    requiresDynamicAgent: raw.promotion?.requiresDynamicAgent ?? null,
    templateId: template.id ?? null,
    rfcEmisor: template.rfcEmisor ?? null,
    portalUrl: template.portalUrl ?? null,
    portalFamily: template.portalFamily ?? null,
    requiredFields: Array.isArray(template.requiredFields) ? template.requiredFields.length : 0,
    steps: Array.isArray(template.steps) ? template.steps.length : 0,
  });
}

candidates.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
console.log(JSON.stringify(candidates, null, 2));
