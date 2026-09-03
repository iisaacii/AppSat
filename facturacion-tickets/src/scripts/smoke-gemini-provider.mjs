import assert from "node:assert/strict";
import { getAiGeminiModel } from "../config/env.mjs";
import { createGeminiClient } from "../shared/gemini-client.mjs";

const provider = createGeminiClient();

if (!provider.client) {
  throw new Error(`Gemini provider is not configured: ${provider.reason}`);
}

try {
  const response = await provider.client.models.generateContent({
    model: getAiGeminiModel(),
    contents: [{
      role: "user",
      parts: [{ text: 'Return only this JSON object: {"ok":true}' }],
    }],
    config: {
      temperature: 0,
      responseMimeType: "application/json",
    },
  });
  const parsed = JSON.parse(response.text);
  assert.equal(parsed.ok, true);
  console.log(JSON.stringify({
    ok: true,
    backend: provider.backend,
    model: getAiGeminiModel(),
    project: provider.project,
    location: provider.location,
  }));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    backend: provider.backend,
    model: getAiGeminiModel(),
    status: error?.status ?? null,
    message: sanitizeMessage(error?.message),
  }));
  process.exitCode = 1;
}

function sanitizeMessage(value) {
  return String(value ?? "Unknown Gemini error")
    .replace(/AIza[A-Za-z0-9_-]+/g, "[REDACTED_API_KEY]")
    .slice(0, 1200);
}
