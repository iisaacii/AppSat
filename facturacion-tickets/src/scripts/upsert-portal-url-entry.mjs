import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const directoryPath = resolve("data/portal-url-directory.json");
const rfcEmisor = normalizeRfc(getCliOption("rfc"));
const url = clean(getCliOption("url"));
const name = clean(getCliOption("name"));
const confidence = normalizeConfidence(getCliOption("confidence") ?? 0.7);
const notes = clean(getCliOption("notes"));

if (!/^[A-Z&]{3,4}\d{6}[A-Z0-9]{3}$/.test(rfcEmisor)) {
  throw new Error("Missing or invalid --rfc=RFC_EMISOR");
}

if (!/^(https?|file):\/\//i.test(url)) {
  throw new Error("Missing or invalid --url. Use http://, https:// or file://");
}

const entries = await loadEntries();
const existingIndex = entries.findIndex((entry) => normalizeRfc(entry.rfcEmisor) === rfcEmisor && entry.url === url);
const entry = {
  rfcEmisor,
  name: name || null,
  url,
  source: "dev_upsert",
  confidence,
  notes: notes || null,
};

if (existingIndex >= 0) {
  entries[existingIndex] = {
    ...entries[existingIndex],
    ...entry,
  };
} else {
  entries.push(entry);
}

entries.sort((a, b) => {
  const rfcCompare = normalizeRfc(a.rfcEmisor).localeCompare(normalizeRfc(b.rfcEmisor));
  return rfcCompare || String(a.url ?? "").localeCompare(String(b.url ?? ""));
});

await writeFile(directoryPath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      action: existingIndex >= 0 ? "updated" : "created",
      entry,
      total: entries.length,
    },
    null,
    2,
  ),
);

async function loadEntries() {
  const raw = await readFile(directoryPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") {
      return "[]";
    }

    throw error;
  });
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error("data/portal-url-directory.json must contain an array");
  }

  return parsed;
}

function getCliOption(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

function normalizeRfc(value) {
  return clean(value).toUpperCase();
}

function normalizeConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0.7;
}

function clean(value) {
  return String(value ?? "").trim();
}
