import { GoogleGenAI } from "@google/genai";
import {
  getGeminiApiKey,
  getGeminiBackend,
  getGeminiVertexLocation,
  getGeminiVertexProject,
} from "../config/env.mjs";

export function getGeminiProviderStatus(overrides = {}) {
  const backend = overrides.backend ?? getGeminiBackend();

  if (backend === "vertex") {
    const project = String(overrides.project ?? getGeminiVertexProject()).trim();
    const location = String(overrides.location ?? getGeminiVertexLocation()).trim();

    return {
      backend,
      configured: Boolean(project && location),
      reason: project && location ? null : "missing_vertex_configuration",
      project: project || null,
      location: location || null,
    };
  }

  const apiKey = overrides.apiKey ?? getGeminiApiKey();
  return {
    backend: "developer",
    configured: Boolean(apiKey),
    reason: apiKey ? null : "missing_api_key",
    project: null,
    location: null,
  };
}

export function buildGeminiClientOptions(overrides = {}) {
  const status = getGeminiProviderStatus(overrides);

  if (!status.configured) {
    return { status, options: null };
  }

  if (status.backend === "vertex") {
    return {
      status,
      options: {
        vertexai: true,
        project: status.project,
        location: status.location,
      },
    };
  }

  return {
    status,
    options: {
      apiKey: overrides.apiKey ?? getGeminiApiKey(),
    },
  };
}

export function createGeminiClient(overrides = {}) {
  const { status, options } = buildGeminiClientOptions(overrides);

  return {
    ...status,
    client: options ? new GoogleGenAI(options) : null,
  };
}
