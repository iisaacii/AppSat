import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  getAiGeminiModel,
  getAiGeminiRequestTimeoutMs,
  getAiGeminiThinkingBudget,
} from "../../config/env.mjs";
import { createGeminiClient } from "../../shared/gemini-client.mjs";
import { aiNavigationResponseSchema } from "../ai-response-schema.mjs";

export async function generateGeminiNavigationPlan({ prompt, pageState, screenshotPath }) {
  const provider = createGeminiClient();

  if (!provider.client) {
    return {
      status: "cannot_solve",
      confidence: 0,
      reason: provider.backend === "vertex"
        ? "Vertex AI no tiene proyecto o ubicacion configurados"
        : "GEMINI_API_KEY no configurada",
      actions: [],
      learnedTemplateCandidate: null,
      providerError: provider.reason,
      providerBackend: provider.backend,
    };
  }

  const ai = provider.client;
  const screenshot = await readFile(resolve(screenshotPath));
  let response = null;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), getAiGeminiRequestTimeoutMs());
  const config = {
    temperature: 0.1,
    responseMimeType: "application/json",
    thinkingConfig: {
      thinkingBudget: getAiGeminiThinkingBudget(),
    },
    abortSignal: abortController.signal,
  };

  if (process.env.AI_GEMINI_RESPONSE_SCHEMA === "true") {
    config.responseJsonSchema = aiNavigationResponseSchema;
  }

  try {
    response = await ai.models.generateContent({
      model: getAiGeminiModel(),
      contents: [
        {
          role: "user",
          parts: [
            {
              text: JSON.stringify(
                {
                  prompt,
                  pageState,
                },
                null,
                2,
              ),
            },
            {
              inlineData: {
                mimeType: "image/png",
                data: screenshot.toString("base64"),
              },
            },
          ],
        },
      ],
      config,
    });
  } catch (error) {
    const retryAfterMs = getRetryAfterMs(error);

    return {
      status: "cannot_solve",
      confidence: 0,
      reason: buildProviderErrorReason(error),
      actions: [],
      learnedTemplateCandidate: null,
      providerError: "gemini_generate_content_failed",
      providerBackend: provider.backend,
      providerStatus: error.status ?? null,
      retryable: error.name === "AbortError" || error.status === 429 || error.status >= 500,
      retryAfterMs,
    };
  } finally {
    clearTimeout(timeout);
  }

  try {
    return JSON.parse(response.text);
  } catch (error) {
    return {
      status: "cannot_solve",
      confidence: 0,
      reason: `Gemini devolvio JSON invalido: ${error.message}`,
      actions: [],
      learnedTemplateCandidate: null,
      providerError: "invalid_gemini_json",
      recoverableInSession: true,
    };
  }
}

function buildProviderErrorReason(error) {
  if (error.name === "AbortError") {
    return "Gemini excedio el timeout de respuesta; reintento programado";
  }

  if (error.status === 429) {
    const retryDelay = extractRetryDelayText(error.message);
    return retryDelay
      ? `Gemini alcanzo limite de cuota; reintenta en ${retryDelay}`
      : "Gemini alcanzo limite de cuota; reintenta en unos segundos";
  }

  return `Gemini fallo: ${error.message}`;
}

function getRetryAfterMs(error) {
  if (error.name === "AbortError") {
    return 30000;
  }

  const retryDelayMs = extractRetryDelayMs(error.message);
  if (retryDelayMs !== null) {
    return retryDelayMs;
  }

  return error.status === 429 ? 60000 : 30000;
}

function extractRetryDelayText(message) {
  const retryDelayMs = extractRetryDelayMs(message);
  return retryDelayMs === null ? null : `${Math.ceil(retryDelayMs / 1000)}s`;
}

function extractRetryDelayMs(message) {
  const match = String(message ?? "").match(/retryDelay"?:"?(\d+s?)"?/i);

  if (match) {
    return Number(match[1].replace(/s$/i, "")) * 1000;
  }

  const textMatch = String(message ?? "").match(/retry in ([0-9.]+s)/i);

  if (textMatch) {
    return Number(textMatch[1].replace(/s$/i, "")) * 1000;
  }

  return null;
}
