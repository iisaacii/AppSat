import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getPortalKnowledgeStoreMode,
  shouldAutopromoteLearnedTemplates,
  shouldUseLearnedPortalTemplates,
  shouldUsePortalFixture,
} from "../config/env.mjs";
import { logger } from "../shared/logger.mjs";
import {
  degradeSharedTemplateCandidate,
  listSharedTemplateCandidates,
  publishSharedTemplateCandidate,
  shouldReadLocalPortalKnowledge,
  shouldUseSharedPortalKnowledge,
} from "./portal-knowledge-repository.mjs";
import { assertPortalTemplate, validatePortalTemplate } from "./template-schema.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const candidatesDir = resolve(rootDir, "data/portal-template-candidates");

export async function saveLearnedTemplateCandidate({ job, extracted = null, template, aiNavigationResult, completed }) {
  const candidate =
    aiNavigationResult?.learnedTemplateCandidate ??
    buildTemplateCandidateFromExecutedActions({ job, extracted, template, aiNavigationResult, completed });

  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const portalTemplate = normalizeCandidateTemplate({
    candidate,
    job,
    extracted,
    template,
    aiNavigationResult,
  });
  const validation = validatePortalTemplate(portalTemplate);
  const status = completed && validation.ok && shouldAutopromoteLearnedTemplates() ? "active_lab" : "draft";
  const document = {
    status,
    source: {
      providerMode: aiNavigationResult.providerMode ?? "gemini",
      jobId: job.id,
      createdAt: new Date().toISOString(),
    },
    validation,
    template: portalTemplate,
  };
  const fileName = `${safeFilePart(portalTemplate.rfcEmisor)}-${safeFilePart(getUrlHost(portalTemplate.portalUrl))}-${safeFilePart(job.id)}.candidate.json`;
  const path = resolve(candidatesDir, fileName);

  await mkdir(candidatesDir, { recursive: true });
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  const shared = await publishTemplateCandidateDocument({ document, sourcePath: path });

  return {
    path,
    sharedPath: shared?.path ?? null,
    status,
    validation,
    templateId: portalTemplate.id,
  };
}

export async function loadLearnedPortalTemplates({ rfcEmisor = null, templateId = null } = {}) {
  if (!shouldUseLearnedPortalTemplates()) {
    return [];
  }

  const files = shouldReadLocalPortalKnowledge()
    ? await listCandidateFiles(candidatesDir).catch(() => [])
    : [];
  const activeCandidates = [];

  for (const filePath of files) {
    const raw = JSON.parse(await readFile(filePath, "utf8"));

    if (!["active", "active_lab"].includes(raw.status)) {
      continue;
    }

    if (isFilePortalUrl(raw.template?.portalUrl) && !shouldUsePortalFixture()) {
      continue;
    }

    if (rfcEmisor && normalizeRfc(raw.template?.rfcEmisor) !== normalizeRfc(rfcEmisor)) {
      continue;
    }

    if (templateId && raw.template?.id !== templateId) {
      continue;
    }

    activeCandidates.push({
      createdAt: raw.source?.createdAt ?? "",
      template: assertPortalTemplate(raw.template),
    });
  }

  for (const record of await listSharedTemplateCandidatesSafely({ rfcEmisor, templateId })) {
    const raw = record.candidate;

    if (!["active", "active_lab"].includes(record.status ?? raw.status)) {
      continue;
    }

    if (isFilePortalUrl(raw.template?.portalUrl) && !shouldUsePortalFixture()) {
      continue;
    }

    activeCandidates.push({
      createdAt: record.sourceCreatedAt ?? raw.source?.createdAt ?? "",
      template: assertPortalTemplate(raw.template),
    });
  }

  const latestByEmitter = new Map();

  for (const candidate of activeCandidates.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))) {
    const rfcEmisor = candidate.template.rfcEmisor;

    if (!latestByEmitter.has(rfcEmisor)) {
      latestByEmitter.set(rfcEmisor, candidate.template);
    }
  }

  return [...latestByEmitter.values()];
}

function normalizeCandidateTemplate({ candidate, job, extracted, template, aiNavigationResult }) {
  const rfcEmisor = String(
    candidate.rfcEmisor ?? extracted?.rfcEmisor ?? job.rfcEmisor ?? job.extractedData?.rfcEmisor ?? "",
  ).trim();
  const portalUrl = String(candidate.portalUrl ?? aiNavigationResult.portalUrl ?? template?.portalUrl ?? job.portalUrl ?? "").trim();
  const id = candidate.id || `learned-${safeFilePart(rfcEmisor)}-${safeFilePart(getUrlHost(portalUrl))}`;

  return {
    schemaVersion: "portal-template.v1",
    id,
    name: candidate.name || `Learned ${rfcEmisor}`,
    rfcEmisor,
    portalUrl,
    portalFamily: candidate.portalFamily ?? "ai_learned",
    requiredFields: Array.isArray(candidate.requiredFields) ? candidate.requiredFields : [],
    steps: Array.isArray(candidate.steps) ? candidate.steps : [],
    rateLimit: candidate.rateLimit ?? {
      concurrency: 1,
      perMinute: 6,
    },
  };
}

function buildTemplateCandidateFromExecutedActions({ job, extracted, template, aiNavigationResult, completed }) {
  if (!completed || !aiNavigationResult?.turns?.length || !aiNavigationResult?.portalUrl) {
    return null;
  }

  const requiredFields = new Map();
  const steps = [
    {
      type: "goto",
      urlFrom: "portalUrl",
    },
  ];
  const actionRecords = aiNavigationResult.turns.flatMap((turn) => turn.execution ?? []);

  for (const action of actionRecords) {
    if (action.status !== "completed") {
      continue;
    }

    const step = buildTemplateStepFromAiAction(action, requiredFields);

    if (step) {
      steps.push(step);
    }
  }

  if (!steps.some((step) => step.type === "download") || !steps.some((step) => step.type === "finalSubmit")) {
    return null;
  }

  return {
    id: `learned-${safeFilePart(extracted?.rfcEmisor ?? job.rfcEmisor ?? job.extractedData?.rfcEmisor)}-${safeFilePart(
      getUrlHost(aiNavigationResult.portalUrl),
    )}`,
    name: `Learned ${extracted?.rfcEmisor ?? job.rfcEmisor ?? job.extractedData?.rfcEmisor ?? "portal"}`,
    rfcEmisor: extracted?.rfcEmisor ?? job.rfcEmisor ?? job.extractedData?.rfcEmisor,
    portalUrl: aiNavigationResult.portalUrl,
    portalFamily: template?.portalFamily ?? "ai_learned",
    requiredFields: [...requiredFields.values()],
    steps,
    rateLimit: template?.rateLimit ?? {
      concurrency: 1,
      perMinute: 6,
    },
  };
}

function buildTemplateStepFromAiAction(action, requiredFields) {
  if (["fill", "setValue", "select"].includes(action.type)) {
    const valueKey = action.valueKey ?? inferValueKey(action);
    const field = applyActionFormatToField(mapAiValueKeyToTemplateField(valueKey), action);

    if (!field || !action.selector) {
      return null;
    }

    requiredFields.set(field.name, field);
    return {
      type: action.type,
      selector: action.selector,
      valueFrom: field.name,
    };
  }

  if (["check", "click", "finalSubmit", "waitForSelector"].includes(action.type) && action.selector) {
    return {
      type: action.type,
      selector: action.selector,
      ...(action.type === "check" ? { checked: action.checked ?? true } : {}),
    };
  }

  if (action.type === "clickText" && action.valueKey) {
    const field = applyActionFormatToField(mapAiValueKeyToTemplateField(action.valueKey), action);

    if (!field) {
      return null;
    }

    requiredFields.set(field.name, field);
    return {
      type: "clickText",
      textFrom: field.name,
      exact: action.exact === true,
    };
  }

  if (action.type === "clickText" && action.text) {
    return {
      type: "clickText",
      text: action.text,
      exact: action.exact === true,
    };
  }

  if (action.type === "waitForLoadState") {
    return {
      type: "waitForLoadState",
      state: "domcontentloaded",
    };
  }

  if (action.type === "downloadCfdi" && action.xmlSelector && action.pdfSelector) {
    return {
      type: "download",
      selector: action.pdfSelector,
      xmlSelector: action.xmlSelector,
      pdfSelector: action.pdfSelector,
      captureDownloads: true,
    };
  }

  return null;
}

function applyActionFormatToField(field, action) {
  if (!field || !action.format) {
    return field;
  }

  return {
    ...field,
    format: action.format,
  };
}

function mapAiValueKeyToTemplateField(valueKey) {
  const key = String(valueKey ?? "").trim();
  const portalDiscoveryField = mapPortalDiscoveryValueKey(key);

  if (portalDiscoveryField) {
    return portalDiscoveryField;
  }

  const mappings = new Map([
    ["ticket.rfcEmisor", { name: "rfcEmisor", source: "rfcEmisor", label: "RFC emisor" }],
    ["ticket.folio", { name: "folio", source: "folio", label: "Folio" }],
    ["ticket.ticketId", { name: "ticketId", source: "ocrCandidates.ticketId", label: "ID de ticket" }],
    ["ticket.fecha", { name: "fecha", source: "fecha", label: "Fecha del ticket" }],
    ["ticket.monto", { name: "monto", source: "monto", label: "Monto total" }],
    ["taxProfile.rfc", { name: "taxRfc", source: "taxProfile.rfc", label: "RFC receptor" }],
    ["taxProfile.legalName", { name: "taxLegalName", source: "taxProfile.legalName", label: "Razon social" }],
    ["taxProfile.email", { name: "taxEmail", source: "taxProfile.email", label: "Email" }],
    ["taxProfile.fiscalRegime", { name: "taxFiscalRegime", source: "taxProfile.fiscalRegime", label: "Regimen fiscal" }],
    ["taxProfile.cfdiUse", { name: "taxCfdiUse", source: "taxProfile.cfdiUse", label: "Uso CFDI" }],
    ["taxProfile.postalCode", { name: "taxPostalCode", source: "taxProfile.postalCode", label: "Codigo postal" }],
    ["taxProfile.street", { name: "taxStreet", source: "taxProfile.street", label: "Calle" }],
    ["taxProfile.exteriorNumber", { name: "taxExteriorNumber", source: "taxProfile.exteriorNumber", label: "Numero exterior" }],
    [
      "taxProfile.interiorNumber",
      { name: "taxInteriorNumber", source: "taxProfile.interiorNumber", label: "Numero interior", optional: true },
    ],
    ["taxProfile.neighborhood", { name: "taxNeighborhood", source: "taxProfile.neighborhood", label: "Colonia" }],
    ["taxProfile.municipality", { name: "taxMunicipality", source: "taxProfile.municipality", label: "Municipio" }],
    ["taxProfile.state", { name: "taxState", source: "taxProfile.state", label: "Estado" }],
    ["taxProfile.country", { name: "taxCountry", source: "taxProfile.country", label: "Pais" }],
  ]);

  return mappings.get(key) ?? null;
}

function mapPortalDiscoveryValueKey(key) {
  const match = key.match(/^context\.portalDiscovery\.fields\.([A-Za-z0-9_-]+)$/);

  if (!match) {
    return null;
  }

  const fieldName = match[1];

  return {
    name: fieldName,
    source: `portalDiscovery.fields.${fieldName}`,
    label: humanizeFieldName(fieldName),
  };
}

function humanizeFieldName(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function inferValueKey(action) {
  const probe = `${action.selector ?? ""} ${action.reason ?? ""}`.toLowerCase();

  if (probe.includes("cfdi")) return "taxProfile.cfdiUse";
  if (probe.includes("regfis") || probe.includes("regimen")) return "taxProfile.fiscalRegime";
  if (probe.includes("estado")) return "taxProfile.state";
  if (probe.includes("codigo") || probe.includes("postal")) return "taxProfile.postalCode";
  if (probe.includes("rfc")) return "taxProfile.rfc";
  if (probe.includes("razon")) return "taxProfile.legalName";
  if (probe.includes("email") || probe.includes("correo")) return "taxProfile.email";
  if (probe.includes("venta") || probe.includes("ticket id")) return "ticket.ticketId";
  if (probe.includes("folio")) return "ticket.folio";
  if (probe.includes("fecha")) return "ticket.fecha";
  if (probe.includes("total") || probe.includes("monto")) return "ticket.monto";

  return null;
}

function getUrlHost(value) {
  try {
    const parsed = new URL(value);
    return parsed.hostname || parsed.protocol.replace(/:$/, "") || "local";
  } catch {
    return "unknown";
  }
}

function isFilePortalUrl(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .startsWith("file://");
}

async function listCandidateFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listCandidateFiles(entryPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".candidate.json") && extname(entry.name) === ".json") {
      files.push(entryPath);
    }
  }

  return files.sort();
}

function safeFilePart(value) {
  return String(value ?? "unknown")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export async function degradeTemplateCandidate({ templateId, reason = "template_runtime_error" } = {}) {
  if (!templateId) {
    return;
  }

  const files = await listCandidateFiles(candidatesDir).catch(() => []);

  for (const filePath of files) {
    try {
      const raw = JSON.parse(await readFile(filePath, "utf8"));

      if (raw.template?.id === templateId) {
        if (["active", "active_lab", "replay_passed_1"].includes(raw.status)) {
          const previousStatus = raw.status;
          raw.status = "degraded";
          raw.review = {
            ...(raw.review ?? {}),
            previousStatus,
            status: "degraded",
            reason,
            reviewedAt: new Date().toISOString(),
          };

          await writeFile(filePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
          console.log(`[Outcome Memory] Degraded candidate template ${templateId} from ${previousStatus} to degraded.`);
          break;
        }
      }
    } catch (err) {
      console.error(`[Outcome Memory] Failed to degrade template candidate at ${filePath}:`, err.message);
    }
  }

  if (shouldUseSharedPortalKnowledge()) {
    try {
      await degradeSharedTemplateCandidate({ templateId, reason });
    } catch (error) {
      handleSharedKnowledgeError("Could not degrade shared template candidate.", error, { templateId, reason });
    }
  }
}

export async function publishTemplateCandidateDocument({ document, sourcePath }) {
  if (!shouldUseSharedPortalKnowledge()) {
    return null;
  }

  try {
    return await publishSharedTemplateCandidate({ document, sourcePath });
  } catch (error) {
    handleSharedKnowledgeError("Could not publish learned template to shared registry.", error, {
      templateId: document.template?.id ?? null,
    });
    return null;
  }
}

async function listSharedTemplateCandidatesSafely(options) {
  if (!shouldUseSharedPortalKnowledge()) {
    return [];
  }

  try {
    return await listSharedTemplateCandidates(options);
  } catch (error) {
    handleSharedKnowledgeError("Could not read learned templates from shared registry.", error, options);
    return [];
  }
}

function handleSharedKnowledgeError(message, error, metadata = {}) {
  if (getPortalKnowledgeStoreMode() === "firestore") {
    throw error;
  }

  logger.warn(message, {
    ...metadata,
    error: error.message,
  });
}

function normalizeRfc(value) {
  return String(value ?? "").trim().toUpperCase();
}
