import { getAiGeminiRequestTimeoutMs, getEnv } from "../config/env.mjs";
import { createGeminiClient } from "../shared/gemini-client.mjs";

const defaultSearchModel = "gemini-3.1-flash-lite";

export async function rescuePortalUrl({ browser, failedUrl, job, extracted, timeoutMs = 12000 } = {}) {
  const attempts = [];
  const searchCandidates = await searchPortalCandidatesWithGemini({
    failedUrl,
    job,
    extracted,
  }).catch((error) => ({
    status: "failed",
    error: error.message,
    candidates: [],
  }));

  for (const candidate of searchCandidates.candidates ?? []) {
    const probe = await probeCandidate(browser, candidate, timeoutMs);
    attempts.push(probe);

    if (probe.ok) {
      return {
        status: "resolved",
        source: probe.source,
        selectedUrl: probe.finalUrl ?? probe.url,
        candidates: searchCandidates.candidates ?? [],
        attempts,
        searchResult: searchCandidates,
      };
    }
  }

  return {
    status: "not_resolved",
    selectedUrl: null,
    candidates: searchCandidates.candidates ?? [],
    attempts,
    searchResult: searchCandidates,
  };
}

export function buildDeterministicPortalUrlAlternates(url) {
  const normalized = normalizePortalUrl(url);

  if (!normalized) {
    return [];
  }

  const parsed = new URL(normalized);
  const hosts = new Set([parsed.hostname]);

  if (parsed.hostname.startsWith("www.")) {
    hosts.add(parsed.hostname.slice(4));
  } else {
    hosts.add(`www.${parsed.hostname}`);
  }

  const paths = new Set([
    parsed.pathname && parsed.pathname !== "/" ? parsed.pathname.replace(/\/$/, "") : "",
    "",
    "/facturacion",
    "/facturacion-electronica",
    "/factura",
  ]);
  const candidates = [];

  for (const host of hosts) {
    for (const protocol of ["https:", "http:"]) {
      for (const path of paths) {
        const next = new URL(parsed.href);
        next.protocol = protocol;
        next.hostname = host;
        next.pathname = path || "/";
        next.search = path ? parsed.search : "";
        next.hash = "";
        addCandidate(candidates, next.href.replace(/\/$/, ""), "deterministic_url_variant", 0.82);
      }
    }
  }

  return candidates;
}

async function searchPortalCandidatesWithGemini({ failedUrl, job, extracted }) {
  if (getEnv("PORTAL_DISCOVERY_SEARCH_ENABLED", "true").toLowerCase() !== "true") {
    return { status: "disabled", candidates: [] };
  }

  const provider = createGeminiClient();

  if (!provider.client) {
    return { status: provider.reason, providerBackend: provider.backend, candidates: [] };
  }

  const ai = provider.client;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), getAiGeminiRequestTimeoutMs());
  const prompt = buildSearchPrompt({ failedUrl, job, extracted });

  try {
    const response = await ai.models.generateContent({
      model: getEnv("PORTAL_DISCOVERY_GEMINI_MODEL", getFirstB2Model() ?? defaultSearchModel),
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        temperature: 0,
        responseMimeType: "application/json",
        tools: [{ googleSearch: {} }],
        abortSignal: abortController.signal,
      },
    });
    const parsed = parseJsonResponse(response.text);
    const candidates = [];

    for (const candidate of Array.isArray(parsed?.candidates) ? parsed.candidates : []) {
      addCandidate(
        candidates,
        candidate.url,
        "gemini_google_search",
        Number.isFinite(candidate.confidence) ? candidate.confidence : 0.74,
        candidate.reason,
      );
    }

    return {
      status: candidates.length ? "completed" : "not_found",
      candidates,
      model: getEnv("PORTAL_DISCOVERY_GEMINI_MODEL", getFirstB2Model() ?? defaultSearchModel),
      providerBackend: provider.backend,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeCandidate(browser, candidate, timeoutMs) {
  if (!browser || !candidate?.url) {
    return {
      ok: false,
      url: candidate?.url ?? null,
      source: candidate?.source ?? null,
      error: "missing_browser_or_url",
    };
  }

  const page = await browser.newPage({ ignoreHTTPSErrors: true });

  try {
    await page.goto(candidate.url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});

    const state = await page.evaluate(() => ({
      title: document.title || null,
      bodyText: String(document.body?.innerText ?? "").slice(0, 1200),
      url: location.href,
    }));
    const looksUseful = /factur|cfdi|comprobante|ticket|7-?eleven|seven|invoice|billing/i.test(
      `${state.title ?? ""} ${state.bodyText ?? ""} ${state.url ?? ""}`,
    );

    return {
      ok: looksUseful,
      url: candidate.url,
      finalUrl: state.url,
      source: candidate.source,
      confidence: candidate.confidence,
      title: state.title,
      reason: looksUseful ? "candidate_reachable_and_relevant" : "candidate_reachable_but_not_relevant",
    };
  } catch (error) {
    return {
      ok: false,
      url: candidate.url,
      source: candidate.source,
      confidence: candidate.confidence,
      error: error.message,
    };
  } finally {
    await page.close();
  }
}

function buildSearchPrompt({ failedUrl, job, extracted }) {
  const merchantName = extracted?.ocrCandidates?.emisorNombre ?? null;
  const rfcEmisor = extracted?.rfcEmisor ?? job?.rfcEmisor ?? null;
  const queries = [
    merchantName ? `${merchantName} facturar` : null,
    merchantName ? `${merchantName} facturacion electronica` : null,
    rfcEmisor ? `${rfcEmisor} facturacion` : null,
    failedUrl ? `${failedUrl} facturacion` : null,
  ].filter(Boolean);

  return JSON.stringify(
    {
      task:
        "Find the official Mexican invoice/CFDI portal URL for this merchant. Use Google Search grounding. Search the suggested queries and prefer the first/top official result that actually corresponds to invoice generation. Return JSON only.",
      suggestedQueries: queries,
      failedUrl,
      merchant: {
        rfcEmisor,
        name: merchantName,
        ocrTextPreview: String(extracted?.ocrTextPreview ?? extracted?.ocrText ?? "").slice(0, 1000),
      },
      constraints: [
        "The primary query should be merchant name + 'facturar'.",
        "Prefer official merchant domains over SEO/blog/help pages.",
        "Prefer pages that mention facturacion, factura, CFDI, comprobante, ticket, invoice, or billing.",
        "If there is a dedicated external invoice portal, include it before the corporate landing page.",
        "If the first popular result is official and relevant, rank it first.",
        "Return at most 5 candidates.",
        "Each candidate must be a complete http or https URL.",
      ],
      outputSchema: {
        candidates: [
          {
            url: "https://example.com/facturacion",
            confidence: "number 0..1",
            reason: "short Spanish reason",
          },
        ],
      },
    },
    null,
    2,
  );
}

function parseJsonResponse(text) {
  const raw = String(text ?? "").trim();

  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  }
}

function getFirstB2Model() {
  return String(getEnv("B2_GEMINI_MODEL_CHAIN", "") || getEnv("B2_GEMINI_MODEL", "") || getEnv("AI_GEMINI_MODEL", ""))
    .split(",")
    .map((model) => model.trim())
    .find(Boolean);
}

function addCandidate(candidates, url, source, confidence, reason = null) {
  const normalized = normalizePortalUrl(url);

  if (!normalized || candidates.some((candidate) => candidate.url === normalized)) {
    return;
  }

  candidates.push({
    url: normalized,
    source,
    confidence,
    reason,
  });
}

function normalizePortalUrl(value) {
  const trimmed = String(value ?? "")
    .trim()
    .replace(/[),.;]+$/g, "");

  if (!trimmed || trimmed.includes("@")) {
    return null;
  }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const parsed = new URL(withScheme);

    if (!parsed.hostname.includes(".") || !/[a-z]/i.test(parsed.hostname)) {
      return null;
    }

    parsed.hash = "";
    return parsed.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}
