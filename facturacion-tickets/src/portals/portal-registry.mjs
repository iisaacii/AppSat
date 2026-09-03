import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isAutopilotTemplateFinalSubmitEnabled,
  isFixtureTemplateFinalSubmitEnabled,
  isRealTemplateFinalSubmitEnabled,
  shouldUsePortalFixture,
} from "../config/env.mjs";
import { assertPortalFamily, assertPortalTemplate } from "./template-schema.mjs";
import { loadLearnedPortalTemplates } from "./template-candidates.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const templatesDir = resolve(rootDir, "src/portals/templates");
const familiesDir = resolve(rootDir, "src/portals/families");

export async function findPortalTemplateByRfc(rfcEmisor) {
  const templates = await loadPortalTemplates({ rfcEmisor });
  return templates.find((template) => template.rfcEmisor === rfcEmisor) ?? null;
}

export async function findPortalTemplateById(templateId) {
  if (!templateId) {
    return null;
  }

  const templates = await loadPortalTemplates({ templateId });
  return templates.find((template) => template.id === templateId) ?? null;
}

export async function loadPortalTemplates({ rfcEmisor = null, templateId = null } = {}) {
  const families = await loadPortalFamilies();
  const templates = [];

  for (const learnedTemplate of await loadLearnedPortalTemplates({ rfcEmisor, templateId })) {
    templates.push(assertPortalTemplate(applyFinalSubmitOverrides(learnedTemplate)));
  }

  for (const filePath of await listJsonFiles(templatesDir, ".portal.json")) {
    const raw = await readFile(filePath, "utf8");
    const template = assertPortalTemplate(applyFinalSubmitOverrides(composePortalTemplate(JSON.parse(raw), families)));

    if (rfcEmisor && template.rfcEmisor !== rfcEmisor) {
      continue;
    }

    if (templateId && template.id !== templateId) {
      continue;
    }

    templates.push(template);
  }

  return templates;
}

function applyFinalSubmitOverrides(template) {
  const allowAutopilotSubmit = isAutopilotTemplateFinalSubmitEnabled();

  if (!isFixtureTemplateFinalSubmitEnabled() && !isRealTemplateFinalSubmitEnabled() && !allowAutopilotSubmit) {
    return template;
  }

  if (isFixtureTemplateFinalSubmitEnabled() && !shouldUsePortalFixture()) {
    throw new Error("PORTAL_FIXTURE_ALLOW_TEMPLATE_FINAL_SUBMIT requires PORTAL_USE_FIXTURE=true.");
  }

  if (isRealTemplateFinalSubmitEnabled() && shouldUsePortalFixture()) {
    throw new Error("PORTAL_REAL_ALLOW_TEMPLATE_FINAL_SUBMIT requires PORTAL_USE_FIXTURE=false.");
  }

  if (allowAutopilotSubmit && shouldUsePortalFixture()) {
    throw new Error("PORTAL_AUTOPILOT_ALLOW_TEMPLATE_FINAL_SUBMIT requires PORTAL_USE_FIXTURE=false.");
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

export async function loadPortalFamilies() {
  const families = new Map();

  for (const filePath of await listJsonFiles(familiesDir, ".family.json")) {
    const raw = await readFile(filePath, "utf8");
    const family = assertPortalFamily(JSON.parse(raw));
    families.set(family.id, family);
  }

  return families;
}

function composePortalTemplate(template, families) {
  const family = families.get(template.portalFamily);

  if (!family) {
    return template;
  }

  return {
    ...family,
    ...template,
    templateFamilyName: family.name,
    requiredFields: template.requiredFields ?? family.requiredFields,
    steps: template.steps ?? family.steps,
    rateLimit: template.rateLimit ?? family.rateLimit,
  };
}

async function listJsonFiles(directory, suffix) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listJsonFiles(entryPath, suffix)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(suffix) && extname(entry.name) === ".json") {
      files.push(entryPath);
    }
  }

  return files.sort();
}
