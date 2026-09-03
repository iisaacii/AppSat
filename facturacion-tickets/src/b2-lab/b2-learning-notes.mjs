import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const defaultNotesDir = "data/b2-learning-notes";

export async function readB2LearningNotes(portalUrl, { notesDir = defaultNotesDir } = {}) {
  const filePath = getNotesPath(portalUrl, notesDir);

  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return {
      portalKey: portalKeyFor(portalUrl),
      fieldMappings: [],
      updatedAt: null,
    };
  }
}

export async function saveB2FieldMappingNotes(portalUrl, issues = [], { notesDir = defaultNotesDir } = {}) {
  const notes = await readB2LearningNotes(portalUrl, { notesDir });
  const nextMappings = [...(notes.fieldMappings ?? [])];

  for (const issue of issues) {
    if (!issue.selector || !issue.valueKey) {
      continue;
    }

    const existing = nextMappings.find((mapping) => mapping.selector === issue.selector);
    const mapping = {
      selector: issue.selector,
      label: issue.label ?? null,
      valueKey: issue.valueKey,
      reason: issue.type ?? "field_mapping_repair",
      updatedAt: new Date().toISOString(),
    };

    if (existing) {
      Object.assign(existing, mapping);
    } else {
      nextMappings.push(mapping);
    }
  }

  const next = {
    ...notes,
    fieldMappings: nextMappings,
    updatedAt: new Date().toISOString(),
  };
  const filePath = getNotesPath(portalUrl, notesDir);

  await mkdir(resolve(notesDir), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function getNotesPath(portalUrl, notesDir) {
  return resolve(notesDir, `${portalKeyFor(portalUrl)}.json`);
}

function portalKeyFor(portalUrl) {
  try {
    const url = new URL(portalUrl);
    return `${url.hostname}${url.pathname}`
      .replace(/^www\./, "")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
  } catch {
    return String(portalUrl ?? "unknown")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
  }
}
