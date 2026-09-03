import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { findPortalTemplateByRfc, loadPortalTemplates } from "../portals/portal-registry.mjs";
import { resolveTemplateFields } from "../portals/template-fields.mjs";
import { runPortalTemplate } from "../portals/template-runner.mjs";

process.env.PORTAL_RUNNER_MODE = process.env.PORTAL_RUNNER_MODE ?? "playwright";
process.env.PORTAL_USE_FIXTURE = process.argv.includes("--real") ? "false" : "true";

const runAll = process.argv.includes("--all");
const approveFinalSubmit = process.argv.includes("--approve-final-submit");
const allowTemplateFinalSubmit = process.argv.includes("--allow-template-final-submit");
const rfc = process.argv.find((arg) => arg.startsWith("--rfc="))?.slice("--rfc=".length) ?? "CCO8605231N4";
const contextPath = process.argv
  .find((arg) => arg.startsWith("--context="))
  ?.slice("--context=".length);
const contextOverrides = contextPath ? await readJsonFile(contextPath) : {};

if (approveFinalSubmit && allowTemplateFinalSubmit && !process.argv.includes("--real")) {
  process.env.PORTAL_ALLOW_FINAL_SUBMIT = "true";
}

if (runAll) {
  const templates = (await loadPortalTemplates()).filter((template) => template.fixturePath);
  const results = [];

  for (const template of templates) {
    results.push(await runFixture(applyFixtureOnlyTemplateOverrides(template)));
  }

  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

const template = await findPortalTemplateByRfc(rfc);

if (!template) {
  throw new Error(`Template not found for RFC ${rfc}.`);
}

console.log(JSON.stringify(await runFixture(applyFixtureOnlyTemplateOverrides(template)), null, 2));

async function runFixture(template) {
  const baseContext = {
    id: `fixture_${template.id}`,
    portalFinalSubmitApproved: approveFinalSubmit,
    rfcReceptor: "XAXX010101000",
    rfcEmisor: template.rfcEmisor,
    folio: "474294",
    fecha: "2025-03-11",
    monto: 92,
    taxProfile: {
      rfc: "XAXX010101000",
      legalName: "PERSONA CONTRIBUYENTE DEMO",
      email: "pruebas@easysat.dev",
      fiscalRegime: "605 - Sueldos y Salarios e Ingresos Asimilados a Salarios",
      fiscalRegimes: ["605 - Sueldos y Salarios e Ingresos Asimilados a Salarios"],
      cfdiUse: "S01 - Sin efectos fiscales",
      postalCode: "54040",
      street: "CAOBA",
      exteriorNumber: "23",
      interiorNumber: "",
      neighborhood: "VALLE DE LOS PINOS",
      municipality: "TLALNEPANTLA DE BAZ",
      state: "MEXICO",
      country: "MEXICO",
    },
    ocrCandidates: {
      folioVenta: "474294",
      ticketId: "10PCK503AN1",
      fecha: "2025-03-11",
      monto: 92,
    },
  };
  const context = mergeContext(baseContext, contextOverrides);

  const fieldResolution = resolveTemplateFields(template, context);

  if (fieldResolution.missingFields.length) {
    throw new Error(
      `Missing fixture fields for ${template.id}: ${fieldResolution.missingFields
        .map((field) => field.name)
        .join(", ")}`,
    );
  }

  const result = await runPortalTemplate(template, {
    ...context,
    ...fieldResolution.resolved,
  });

  return {
    templateId: template.id,
    rfcEmisor: template.rfcEmisor,
    requiredFields: fieldResolution.requiredFields.map((field) => field.name),
    resolved: fieldResolution.resolved,
    result,
  };
}

function applyFixtureOnlyTemplateOverrides(template) {
  if (!allowTemplateFinalSubmit) {
    return template;
  }

  if (process.argv.includes("--real")) {
    throw new Error("--allow-template-final-submit is only allowed with fixtures.");
  }

  return {
    ...template,
    steps: template.steps.map((step) =>
      step.type === "finalSubmit"
        ? {
            ...step,
            allowSubmit: true,
          }
        : step,
    ),
  };
}

async function readJsonFile(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

function mergeContext(base, overrides) {
  return {
    ...base,
    ...overrides,
    taxProfile: {
      ...(base.taxProfile ?? {}),
      ...(overrides.taxProfile ?? {}),
    },
    ocrCandidates: {
      ...(base.ocrCandidates ?? {}),
      ...(overrides.ocrCandidates ?? {}),
    },
  };
}
