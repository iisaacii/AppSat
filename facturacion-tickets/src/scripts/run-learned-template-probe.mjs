import { unlink } from "node:fs/promises";
import { loadPortalTemplates } from "../portals/portal-registry.mjs";
import { saveLearnedTemplateCandidate } from "../portals/template-candidates.mjs";

const keep = process.argv.includes("--keep");
const job = {
  id: `learn_probe_${Date.now()}`,
  rfcReceptor: "XAXX010101000",
  taxProfile: {
    rfc: "XAXX010101000",
    legalName: "PERSONA CONTRIBUYENTE DEMO",
    email: "pruebas@appsat.dev",
    fiscalRegime: "605 - Sueldos y Salarios e Ingresos Asimilados a Salarios",
    cfdiUse: "S01 - Sin efectos fiscales",
    postalCode: "54040",
  },
};
const extracted = {
  rfcEmisor: "TST010101TST",
  folio: "ABC123",
  fecha: "2026-05-17",
  monto: 123.45,
  ocrCandidates: {
    ticketId: "TICKET123",
  },
};
const portalUrl = "https://example.com/facturacion";

const saveResult = await saveLearnedTemplateCandidate({
  job,
  extracted,
  template: null,
  completed: true,
  aiNavigationResult: {
    providerMode: "probe",
    portalUrl,
    turns: [
      {
        index: 1,
        execution: [
          {
            type: "fill",
            status: "completed",
            selector: "#folio",
            valueKey: "ticket.folio",
          },
          {
            type: "fill",
            status: "completed",
            selector: "#ticket",
            valueKey: "ticket.ticketId",
          },
          {
            type: "fill",
            status: "completed",
            selector: "#fecha",
            valueKey: "ticket.fecha",
            format: "date:dd/mm/yyyy",
          },
          {
            type: "fill",
            status: "completed",
            selector: "#total",
            valueKey: "ticket.monto",
            format: "number:fixed2",
          },
          {
            type: "fill",
            status: "completed",
            selector: "#rfc",
            valueKey: "taxProfile.rfc",
            format: "rfc:uppercase",
          },
          {
            type: "click",
            status: "completed",
            selector: "#validar",
          },
          {
            type: "check",
            status: "completed",
            selector: "#acepto",
            checked: true,
          },
          {
            type: "clickText",
            status: "completed",
            valueKey: "taxProfile.cfdiUse",
            format: "cfdiUse:code",
            exact: false,
          },
          {
            type: "finalSubmit",
            status: "completed",
            selector: "#emitir",
          },
          {
            type: "downloadCfdi",
            status: "completed",
            xmlSelector: "#download-xml",
            pdfSelector: "#download-pdf",
          },
        ],
      },
    ],
  },
});

if (!saveResult?.validation?.ok || saveResult.status !== "active_lab") {
  throw new Error(`Learn probe failed to save active candidate: ${JSON.stringify(saveResult)}`);
}

const templates = await loadPortalTemplates();
const learnedTemplate = templates.find((template) => template.id === saveResult.templateId);

if (!learnedTemplate) {
  throw new Error(`Learned template not loaded: ${saveResult.templateId}`);
}

const formatFields = new Map(learnedTemplate.requiredFields.map((field) => [field.name, field.format ?? null]));

if (formatFields.get("fecha") !== "date:dd/mm/yyyy") {
  throw new Error("Learned template did not preserve fecha format");
}

if (formatFields.get("monto") !== "number:fixed2") {
  throw new Error("Learned template did not preserve monto format");
}

if (formatFields.get("taxCfdiUse") !== "cfdiUse:code") {
  throw new Error("Learned template did not preserve dynamic clickText format");
}

if (!learnedTemplate.steps.some((step) => step.type === "clickText" && step.textFrom === "taxCfdiUse")) {
  throw new Error("Learned template did not convert dynamic clickText to textFrom");
}

if (!keep && saveResult.path) {
  await unlink(saveResult.path).catch((error) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      kept: keep,
      saveResult,
      loadedTemplate: {
        id: learnedTemplate.id,
        rfcEmisor: learnedTemplate.rfcEmisor,
        portalUrl: learnedTemplate.portalUrl,
        requiredFields: learnedTemplate.requiredFields.length,
        steps: learnedTemplate.steps.length,
        formats: Object.fromEntries(formatFields),
      },
    },
    null,
    2,
  ),
);
