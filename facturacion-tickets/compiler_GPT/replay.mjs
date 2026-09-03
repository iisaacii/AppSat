import { readJson } from "./lib/browser-use-history.mjs";
import { resolveTemplateFields } from "../src/portals/template-fields.mjs";
import { runPortalTemplate } from "../src/portals/template-runner.mjs";

const args = parseArgs(process.argv.slice(2));

if (!args.candidate) {
  throw new Error("Missing --candidate=path/to/compiled.candidate.json");
}

if (!args.fixture) {
  throw new Error("Missing --fixture=path/to/fixture.json");
}

const candidate = await readJson(args.candidate);
const fixture = await readJson(args.fixture);
const profilePath = args.profile ?? "data/tax-profiles/sample.json";
const taxProfile = fixture.taxProfile ?? (await readJson(profilePath).catch(() => ({})));
const template = candidate.template;
const context = {
  ...fixture,
  ...(fixture.ocrCandidates ?? {}),
  taxProfile,
  id: `compiler_gpt_replay_${template.id}`,
  portalFinalSubmitApproved: args["approve-final-submit"] === "true",
};
const fieldResolution = resolveTemplateFields(template, context);

if (fieldResolution.missingFields.length) {
  console.log(
    JSON.stringify(
      {
        ok: false,
        reason: "missing_fields",
        missingFields: fieldResolution.missingFields,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

if (args["dry-run"] === "true") {
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "dry-run",
        templateId: template.id,
        steps: template.steps.length,
        resolvedFields: fieldResolution.resolved,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const result = await runPortalTemplate(template, {
  ...context,
  ...fieldResolution.resolved,
});

console.log(JSON.stringify(result, null, 2));

function parseArgs(argv) {
  const parsed = {};

  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      continue;
    }

    const [key, ...valueParts] = arg.slice(2).split("=");
    parsed[key] = valueParts.length ? valueParts.join("=") : "true";
  }

  return parsed;
}
