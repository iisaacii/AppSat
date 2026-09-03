import { GoogleAuth } from "google-auth-library";
import { getDocumentAiExpenseProcessorName } from "../config/env.mjs";

const authScopes = ["https://www.googleapis.com/auth/cloud-platform"];

export async function extractTicketWithDocumentAiExpense({ image } = {}) {
  const processorName = getDocumentAiExpenseProcessorName();
  if (!processorName) {
    return { available: false, source: "document_ai_expense", reason: "not_configured" };
  }

  const location = processorName.match(/\/locations\/([^/]+)\//)?.[1];
  if (!location || !/^projects\/[^/]+\/locations\/[^/]+\/processors\/[^/]+$/.test(processorName)) {
    return { available: false, source: "document_ai_expense", reason: "invalid_processor_name" };
  }

  const auth = new GoogleAuth({ scopes: authScopes });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  const endpoint = `https://${location}-documentai.googleapis.com/v1/${processorName}:process`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.token ?? token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        rawDocument: {
          content: image.buffer.toString("base64"),
          mimeType: image.contentType,
        },
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const body = await response.json();
    if (!response.ok) {
      return {
        available: false,
        source: "document_ai_expense",
        reason: "provider_error",
        retryable: response.status === 429 || response.status >= 500,
        error: body?.error?.message ?? `HTTP ${response.status}`,
      };
    }

    return normalizeDocumentAiResult(body.document ?? {});
  } catch (error) {
    return {
      available: false,
      source: "document_ai_expense",
      reason: "provider_error",
      retryable: error?.name === "TimeoutError" || error?.name === "AbortError",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeDocumentAiResult(document = {}) {
  const entities = flattenEntities(document.entities ?? []);
  return {
    available: true,
    source: "document_ai_expense",
    confidence: averageConfidence(entities),
    fields: {
      issuerLegalName: firstEntityValue(entities, ["supplier_name", "merchant_name", "vendor_name"]),
      rfcEmisor: firstEntityValue(entities, ["supplier_tax_id", "merchant_tax_id", "tax_id"]),
      fecha: firstEntityValue(entities, ["receipt_date", "expense_date", "purchase_date"]),
      monto: firstEntityValue(entities, ["total_amount", "amount_due", "net_amount"]),
    },
    alternatives: entities
      .filter((entity) => /total_amount|receipt_date|supplier_tax_id|merchant_tax_id/.test(entity.type))
      .map((entity) => ({
        field: mapEntityTypeToField(entity.type),
        value: entity.value,
        confidence: entity.confidence,
        evidence: entity.mentionText ?? entity.value,
      })),
  };
}

function flattenEntities(entities, parent = "") {
  return entities.flatMap((entity) => {
    const type = parent ? `${parent}.${entity.type ?? ""}` : String(entity.type ?? "");
    const value = normalizeEntityValue(entity);
    const current = {
      type: type.toLowerCase(),
      value,
      mentionText: entity.mentionText ?? null,
      confidence: Number(entity.confidence ?? 0.75),
    };
    return [current, ...flattenEntities(entity.properties ?? [], type)];
  });
}

function normalizeEntityValue(entity) {
  const normalized = entity.normalizedValue ?? {};
  if (normalized.moneyValue) {
    const units = Number(normalized.moneyValue.units ?? 0);
    const nanos = Number(normalized.moneyValue.nanos ?? 0);
    return Number.isFinite(units) && Number.isFinite(nanos) ? units + nanos / 1_000_000_000 : null;
  }
  if (normalized.dateValue) {
    const { year, month, day } = normalized.dateValue;
    if (year && month && day) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  return normalized.text ?? entity.mentionText ?? null;
}

function firstEntityValue(entities, types) {
  const matches = entities
    .filter((entity) => types.some((type) => entity.type === type || entity.type.endsWith(`.${type}`)))
    .sort((a, b) => b.confidence - a.confidence);
  return matches[0]?.value ?? null;
}

function mapEntityTypeToField(type) {
  if (type.includes("total")) return "monto";
  if (type.includes("date")) return "fecha";
  if (type.includes("tax_id")) return "rfcEmisor";
  return type;
}

function averageConfidence(entities) {
  const values = entities.map((entity) => entity.confidence).filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0.75;
}
