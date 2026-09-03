import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  buildResolvedAlreadyInvoicedResult,
  buildUserActionRequiredResult,
} from "../orchestrator/user-action-policy.mjs";

const outputPath =
  process.argv.find((arg) => arg.startsWith("--out="))?.slice("--out=".length) ??
  "artifacts/user-action/capa-c-scenarios.latest.json";

const baseJob = {
  id: "capa_c_preview_job",
  uid: "demo_user",
  taxProfileId: "billing_lab_default",
  portalCandidateUrl: "https://facturacion.example.test",
  portalFinalSubmitApproved: true,
};

const extracted = {
  rfcEmisor: "AAA010101AAA",
  folio: "12345",
  fecha: "2026-05-21",
  monto: 99.5,
  codigoFacturacion: "ABC123",
  sucursal: "001",
  serie: "A",
  token: "TOKEN123",
};

const template = {
  id: "example-template",
  name: "Portal ejemplo",
  portalFamily: "example",
  portalUrl: "https://facturacion.example.test",
};

const scenarios = [
  {
    id: "ticket_already_invoiced_with_existing_cfdi",
    description: "Portal indica ticket ya facturado y el job ya tiene CFDI guardado.",
    result: buildResolvedAlreadyInvoicedResult({
      job: {
        ...baseJob,
        resultXmlStoragePath: "billing-lab/cfdis/demo_user/job_123/factura.xml",
        resultPdfStoragePath: "billing-lab/cfdis/demo_user/job_123/factura.pdf",
      },
      extracted,
      template,
      portalRunResult: {
        reason: "ticket_already_invoiced",
        statusMessage: "Este ticket ya fue facturado anteriormente.",
        portalMessage: "Comprobante generado previamente",
        artifacts: {
          screenshotStoragePath: "billing-lab/portal-artifacts/demo_user/job_123/already-invoiced.png",
          htmlStoragePath: "billing-lab/portal-artifacts/demo_user/job_123/already-invoiced.html",
        },
      },
    }),
  },
  {
    id: "ticket_data_rejected",
    description: "Portal rechaza un dato del ticket; Flutter debe mostrar screenshot y campo editable.",
    result: buildUserActionRequiredResult({
      reason: "ticket_not_found",
      statusMessage: "El portal no encontro el ticket con esos datos.",
      job: baseJob,
      extracted,
      template,
      portalRunResult: {
        reason: "ticket_not_found",
        portalMessage: "Codigo de facturacion invalido",
        missingFields: ["codigoFacturacion"],
        currentUrl: "https://facturacion.example.test/validar-ticket",
        artifacts: {
          screenshotStoragePath: "billing-lab/portal-artifacts/demo_user/job_124/ticket-rejected.png",
          htmlStoragePath: "billing-lab/portal-artifacts/demo_user/job_124/ticket-rejected.html",
        },
      },
    }),
  },
  {
    id: "captcha_required",
    description: "Portal pide CAPTCHA; se guarda checkpoint para sesion interactiva corta sin IA.",
    result: buildUserActionRequiredResult({
      reason: "captcha_detected",
      statusMessage: "El portal requiere resolver un CAPTCHA.",
      job: baseJob,
      extracted,
      template,
      portalRunResult: {
        reason: "captcha_detected",
        currentUrl: "https://facturacion.example.test/captcha",
        artifacts: {
          screenshotPath: "artifacts/portal-runs/job_125/captcha.png",
          htmlPath: "artifacts/portal-runs/job_125/captcha.html",
        },
      },
    }),
  },
  {
    id: "portal_missing",
    description: "No hay receta ni portal suficiente; Flutter debe mostrar intervencion manual/checkpoint.",
    result: buildUserActionRequiredResult({
      reason: "portal_template_missing",
      statusMessage: "No hay portal automatizado para este emisor.",
      job: {
        ...baseJob,
        portalCandidateUrl: null,
      },
      extracted: {
        ...extracted,
        rfcEmisor: "XXX010101XXX",
      },
      template: null,
      failure: {
        type: "portal_missing",
        reason: "portal_template_missing",
      },
    }),
  },
];

const preview = scenarios.map((scenario) => summarizeScenario(scenario));
const payload = {
  ok: true,
  generatedAt: new Date().toISOString(),
  scenarios: preview,
  raw: scenarios.map((scenario) => ({
    id: scenario.id,
    description: scenario.description,
    result: scenario.result,
  })),
};

await mkdir(dirname(resolve(outputPath)), { recursive: true });
await writeFile(resolve(outputPath), `${JSON.stringify(payload, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ ...payload, outputPath: resolve(outputPath), raw: undefined }, null, 2));

function summarizeScenario({ id, description, result }) {
  return {
    id,
    description,
    jobStatus: result.status,
    reason: result.reason,
    statusMessage: result.statusMessage,
    userActionStatus: result.userAction?.status ?? null,
    userActionReason: result.userAction?.reason ?? null,
    expectedNextStep: result.userAction?.expectedNextStep ?? null,
    editableFields: (result.userAction?.editableFields ?? []).map((field) => field.key),
    evidence: result.userAction?.evidence ?? null,
    checkpoint: {
      portalUrl: result.userAction?.checkpoint?.portalUrl ?? null,
      currentUrl: result.userAction?.checkpoint?.currentUrl ?? null,
      templateId: result.userAction?.checkpoint?.templateId ?? null,
      rfcEmisor: result.userAction?.checkpoint?.rfcEmisor ?? null,
      ticketData: result.userAction?.checkpoint?.ticketData ?? null,
    },
    existingCfdi: result.userAction?.existingCfdi ?? null,
  };
}
