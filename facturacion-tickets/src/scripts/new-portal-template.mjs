import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));

const required = ["id", "name", "merchant", "rfc", "family", "url"];
const missing = required.filter((key) => !args[key]);

if (missing.length) {
  throw new Error(`Missing required args: ${missing.map((key) => `--${key}`).join(", ")}`);
}

const filePath = resolve("src/portals/templates", `${args.id}.portal.json`);

if (existsSync(filePath)) {
  throw new Error(`Template already exists: ${filePath}`);
}

const template = {
  schemaVersion: "portal-template.v1",
  id: args.id,
  name: args.name,
  merchantName: args.merchant,
  rfcEmisor: args.rfc,
  portalFamily: args.family,
  portalUrl: args.url,
  fixturePath: args.fixture ?? `src/portals/fixtures/${args.id}.html`,
  active: args.active === "true",
};

await mkdir(dirname(filePath), { recursive: true });
await writeFile(`${filePath}`, `${JSON.stringify(template, null, 2)}\n`, "utf8");

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
