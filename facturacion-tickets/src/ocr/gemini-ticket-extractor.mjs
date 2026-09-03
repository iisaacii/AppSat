import {
  getAiGeminiRequestTimeoutMs,
  getGeminiTicketVisionModel,
  isGeminiTicketVisionEnabled,
} from "../config/env.mjs";
import { createGeminiClient } from "../shared/gemini-client.mjs";

const responseSchema = {
  type: "object",
  properties: {
    document: {
      type: "object",
      properties: {
        isTicket: { type: "boolean" },
        hasReadableText: { type: "boolean" },
        visibleTextSample: { type: ["string", "null"] },
      },
      required: ["isTicket", "hasReadableText", "visibleTextSample"],
    },
    issuer: {
      type: "object",
      properties: {
        rfc: { type: ["string", "null"] },
        legalName: { type: ["string", "null"] },
      },
      required: ["rfc", "legalName"],
    },
    ticket: {
      type: "object",
      properties: {
        date: { type: ["string", "null"] },
        total: { type: ["number", "null"] },
        folio: { type: ["string", "null"] },
        ticketId: { type: ["string", "null"] },
        billingCode: { type: ["string", "null"] },
        branch: { type: ["string", "null"] },
        series: { type: ["string", "null"] },
        token: { type: ["string", "null"] },
        terminal: { type: ["string", "null"] },
        webId: { type: ["string", "null"] },
        permisoCre: { type: ["string", "null"] },
      },
      required: [
        "date",
        "total",
        "folio",
        "ticketId",
        "billingCode",
        "branch",
        "series",
        "token",
        "terminal",
        "webId",
        "permisoCre",
      ],
    },
    alternatives: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string" },
          value: { type: "string" },
          confidence: { type: "number" },
          evidence: { type: "string" },
        },
        required: ["field", "value", "confidence", "evidence"],
      },
    },
    confidence: { type: "number" },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["document", "issuer", "ticket", "alternatives", "confidence", "notes"],
};

export async function extractTicketWithGeminiVision({ image, receiverRfc = null } = {}) {
  if (!isGeminiTicketVisionEnabled()) {
    return { available: false, source: "gemini_vision", reason: "disabled" };
  }

  const provider = createGeminiClient();
  if (!provider.client) {
    return {
      available: false,
      source: "gemini_vision",
      reason: provider.reason,
      providerBackend: provider.backend,
    };
  }

  const ai = provider.client;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getAiGeminiRequestTimeoutMs());

  try {
    const response = await ai.models.generateContent({
      model: getGeminiTicketVisionModel(),
      contents: [{
        role: "user",
        parts: [
          {
            text: buildPrompt(receiverRfc),
          },
          {
            inlineData: {
              mimeType: image.contentType,
              data: image.buffer.toString("base64"),
            },
          },
        ],
      }],
      config: {
        temperature: 0,
        responseMimeType: "application/json",
        responseJsonSchema: responseSchema,
        abortSignal: controller.signal,
      },
    });
    const parsed = JSON.parse(response.text);
    return normalizeGeminiResult(parsed);
  } catch (error) {
    return {
      available: false,
      source: "gemini_vision",
      reason: "provider_error",
      providerBackend: provider.backend,
      retryable: error?.name === "AbortError" || error?.status === 429 || Number(error?.status) >= 500,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildPrompt(receiverRfc) {
  return [
    "Primero determina si la imagen contiene un ticket o comprobante de compra real con texto legible.",
    "Si la imagen esta vacia, es ajena a un ticket o no tiene texto suficiente, establece document.isTicket=false o document.hasReadableText=false y devuelve null en TODOS los campos.",
    "Extrae datos visibles de este ticket mexicano para emitir un CFDI.",
    "No inventes valores, no completes por conocimiento externo y usa null cuando no sea legible.",
    "Cada valor reportado debe aparecer literalmente en la imagen; visibleTextSample debe ser una muestra breve y literal del encabezado visible.",
    "Distingue el RFC del EMISOR impreso en el ticket del RFC receptor del cliente.",
    receiverRfc ? `El RFC receptor del cliente es ${receiverRfc}; no lo reportes como RFC emisor.` : null,
    "El total es la cantidad etiquetada TOTAL, GRAN TOTAL o TOTAL A PAGAR. No uses subtotal, IVA, descuento, cambio, propina, efectivo recibido ni el precio de un articulo.",
    "Conserva ceros iniciales y caracteres exactos en folios, IDs, codigos de facturacion, tokens y permisos CRE.",
    "Normaliza la fecha como YYYY-MM-DD y el total como numero decimal.",
    "En tickets mexicanos interpreta fechas separadas por punto, diagonal o guion como DD.MM.AA/DD.MM.AAAA salvo evidencia explicita de otro formato; por ejemplo 13.06.26 significa 2026-06-13, nunca 2013-06-26.",
    "Si hay dos lecturas plausibles, elige la mejor y agrega la otra en alternatives con evidencia breve.",
    "Permiso CRE puede verse como PL/12345/EXP/ES/2015 o una variante similar.",
  ].filter(Boolean).join("\n");
}

function normalizeGeminiResult(value = {}) {
  const ticket = value.ticket ?? {};
  const issuer = value.issuer ?? {};
  const document = value.document ?? {};
  const model = getGeminiTicketVisionModel();
  if (document.isTicket !== true || document.hasReadableText !== true) {
    return {
      available: false,
      source: "gemini_vision",
      model,
      reason: "not_readable_ticket",
      document: {
        isTicket: document.isTicket === true,
        hasReadableText: document.hasReadableText === true,
      },
    };
  }
  return {
    available: true,
    source: "gemini_vision",
    model,
    confidence: clampConfidence(value.confidence, 0.75),
    document: {
      isTicket: true,
      hasReadableText: true,
      visibleTextSample: cleanSample(document.visibleTextSample),
    },
    fields: {
      rfcEmisor: issuer.rfc,
      issuerLegalName: issuer.legalName,
      fecha: ticket.date,
      monto: ticket.total,
      folio: ticket.folio,
      ticketId: ticket.ticketId,
      codigoFacturacion: ticket.billingCode,
      sucursal: ticket.branch,
      serie: ticket.series,
      token: ticket.token,
      terminal: ticket.terminal,
      webId: ticket.webId,
      permisoCre: ticket.permisoCre,
    },
    alternatives: Array.isArray(value.alternatives) ? value.alternatives : [],
    notes: Array.isArray(value.notes) ? value.notes.slice(0, 12) : [],
  };
}

function cleanSample(value) {
  const sample = String(value ?? "").replace(/\s+/g, " ").trim();
  return sample ? sample.slice(0, 240) : null;
}

function clampConfidence(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
}
