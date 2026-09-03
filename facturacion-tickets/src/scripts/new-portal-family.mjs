import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));

const required = ["id", "name"];
const missing = required.filter((key) => !args[key]);

if (missing.length) {
  throw new Error(`Missing required args: ${missing.map((key) => `--${key}`).join(", ")}`);
}

const filePath = resolve("src/portals/families", `${args.id}.family.json`);

if (existsSync(filePath)) {
  throw new Error(`Family already exists: ${filePath}`);
}

const family = {
  id: args.id,
  schemaVersion: "portal-template.v1",
  name: args.name,
  rateLimit: {
    concurrency: Number(args.concurrency ?? 1),
    perMinute: Number(args.perMinute ?? 10),
  },
  requiredFields: [
    {
      name: "rfcReceptor",
      label: "RFC receptor",
      source: "rfcReceptor",
    },
    {
      name: "fecha",
      label: "Fecha",
      source: "fecha",
    },
    {
      name: "monto",
      label: "Monto total",
      source: "monto",
    },
  ],
  steps: [
    {
      type: "goto",
      urlFrom: "portalUrl",
    },
    {
      type: "waitForSelector",
      selector: "#TODO",
    },
    {
      type: "fill",
      selector: "#TODO-rfc",
      valueFrom: "rfcReceptor",
    },
    {
      type: "download",
      selector: "a.download-cfdi",
    },
  ],
};

await mkdir(dirname(filePath), { recursive: true });
await writeFile(`${filePath}`, `${JSON.stringify(family, null, 2)}\n`, "utf8");

console.log(`Created ${filePath}`);

function parseArgs(items) {
  return Object.fromEntries(
    items
      .filter((item) => item.startsWith("--") && item.includes("="))
      .map((item) => {
        const [key, ...value] = item.slice(2).split("=");
        return [key, value.join("=")];
      }),
  );
}
