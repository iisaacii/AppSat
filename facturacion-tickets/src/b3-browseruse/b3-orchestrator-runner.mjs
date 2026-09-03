import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { publishTemplateCandidateDocument } from "../portals/template-candidates.mjs";
import { validateExternalUrlStructure } from "../security/external-url-policy.mjs";

const execFileAsync = promisify(execFile);

export function canRunB3BrowserUse() {
  return process.env.B3_BROWSER_USE_ENABLED !== "false";
}

export async function runB3BrowserUseFallback({
  job,
  extracted,
  taxProfile,
  fiscalCompliance,
  portalUrl = null,
  template = null,
  failure = null,
  signal = null,
} = {}) {
  if (!canRunB3BrowserUse()) {
    return null;
  }

  const fixturePath = await writeB3Fixture({
    job,
    extracted,
    taxProfile,
    fiscalCompliance,
    portalUrl,
    template,
    failure,
  });
  const timeoutMs = Number(process.env.B3_BROWSER_USE_TIMEOUT_MS ?? 900000);
  const python = process.env.B3_PYTHON_BIN ?? "python";
  const env = {
    ...process.env,
    B3_SAVE_LEARNED_TEMPLATE: process.env.B3_SAVE_LEARNED_TEMPLATE ?? "true",
    B3_AUTO_COMPILE_TO_A: process.env.B3_AUTO_COMPILE_TO_A ?? "true",
    B3_AUTO_REPLAY_A: process.env.B3_AUTO_REPLAY_A ?? "true",
    B3_BROWSER_USE_MODEL: process.env.B3_BROWSER_USE_MODEL ?? "gemini-3.1-flash-lite",
    B3_BROWSER_USE_CALCULATE_COST: process.env.B3_BROWSER_USE_CALCULATE_COST ?? "false",
    PYTHONIOENCODING: process.env.PYTHONIOENCODING ?? "utf-8",
    PYTHONUTF8: process.env.PYTHONUTF8 ?? "1",
  };
  const args = ["src/b3-browseruse/run_b3_browseruse.py", `--fixture=${fixturePath}`, "--full"];

  if (process.env.B3_BROWSER_USE_MAX_STEPS) {
    args.push(`--max-steps=${process.env.B3_BROWSER_USE_MAX_STEPS}`);
  }

  try {
    const completed = await execFileAsync(python, args, {
      cwd: resolve("."),
      env,
      timeout: timeoutMs,
      maxBuffer: 50 * 1024 * 1024,
      windowsHide: true,
      signal: signal ?? undefined,
    });
    const result = parseJsonFromStdout(completed.stdout);

    return persistLearnedTemplateCandidate(normalizeB3Result({
      result,
      fixturePath,
      command: [python, ...args],
      stderr: completed.stderr,
    }));
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason ?? error;
    }
    const stdout = error.stdout ?? "";
    const parsed = parseJsonFromStdout(stdout);

    return persistLearnedTemplateCandidate(normalizeB3Result({
      result: parsed ?? {
        ok: false,
        status: "failed",
        reason: "b3_execution_failed",
        statusMessage: error.message,
      },
      fixturePath,
      command: [python, ...args],
      stderr: error.stderr,
      executionError: error.message,
    }));
  }
}

export function b3ResultHasCfdi(result) {
  return Boolean((result?.xmlPath || result?.xmlUrl) && (result?.pdfPath || result?.pdfUrl));
}

export function b3ResultHasFiscalXml(result) {
  return Boolean(result?.xmlPath || result?.xmlUrl);
}

async function writeB3Fixture({ job = {}, extracted = {}, taxProfile = {}, fiscalCompliance = {}, portalUrl, template, failure }) {
  const id = sanitizePathSegment(job.id ?? `b3_job_${Date.now()}`);
  const path = resolve("artifacts/b3-orchestrator-fixtures", `${id}.json`);
  const candidates = extracted.ocrCandidates ?? {};
  const fixture = {
    id,
    sourceType: extracted.sourceType ?? "orchestrator",
    ticketFileUrl: job.ticketFileUrl ?? null,
    ticketImagePath: normalizeLocalTicketPath(job.ticketFileUrl),
    portalUrl:
      portalUrl ??
      job.aiPortalUrl ??
      job.portalCandidateUrl ??
      job.portalUrl ??
      extracted.portalUrl ??
      template?.portalUrl ??
      null,
    portalCandidates: buildPortalCandidates({ job, extracted, template }),
    portalSource: "orchestrator",
    rfcEmisor: extracted.rfcEmisor ?? job.rfcEmisor ?? template?.rfcEmisor ?? null,
    folio: extracted.folio ?? job.folio ?? null,
    fecha: extracted.fecha ?? job.fecha ?? null,
    monto: extracted.monto ?? job.monto ?? null,
    permisoCre: extracted.permisoCre ?? candidates.permisoCre ?? job.permisoCre ?? null,
    estacionCodigo: extracted.estacionCodigo ?? candidates.estacionCodigo ?? null,
    estacionNombre: extracted.estacionNombre ?? candidates.estacionNombre ?? null,
    businessDomain: extracted.businessDomain ?? candidates.businessDomain ?? null,
    ticketEnrichment: extracted.ticketEnrichment ?? null,
    ocrResolution: extracted.ocrResolution ?? null,
    ocrCandidates: {
      ...candidates,
      autonomousCandidateSets:
        candidates.autonomousCandidateSets ?? extracted.ocrResolution?.candidateSets ?? [],
      rfc: candidates.rfc ?? (extracted.rfcEmisor ? [extracted.rfcEmisor] : undefined),
      folio: candidates.folio ?? extracted.folio ?? undefined,
      folioTicket: candidates.folioTicket ?? extracted.folio ?? undefined,
      fecha: candidates.fecha ?? extracted.fecha ?? undefined,
      monto: candidates.monto ?? extracted.monto ?? undefined,
      portalUrls: [
        ...toArray(candidates.portalUrls),
        ...toArray(job.portalCandidates).map((candidate) => candidate?.url).filter(Boolean),
        job.portalCandidateUrl,
        job.aiPortalUrl,
        extracted.portalUrl,
        template?.portalUrl,
      ].filter(Boolean),
    },
    ocrText: extracted.ocrText ?? extracted.ocrTextPreview ?? "",
    taxProfile,
    fiscalCompliance,
    orchestratorFailure: failure,
    sourceTemplate: template
      ? {
          id: template.id,
          name: template.name,
          portalFamily: template.portalFamily ?? null,
          portalUrl: template.portalUrl ?? null,
        }
      : null,
  };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");

  return path;
}

function normalizeB3Result({ result, fixturePath, command, stderr, executionError }) {
  const downloads = toArray(result?.downloads);
  const xml = downloads.find((item) => item.kind === "xml");
  const pdf = downloads.find((item) => item.kind === "pdf");
  const hasXml = Boolean(xml);
  const hasPdf = Boolean(pdf);
  const normalizedStatus = normalizeB3Status(result?.status);
  const status = normalizedStatus === "completed" && !hasXml ? "needs_user_action" : normalizedStatus;
  const reason =
    status === "completed" && hasXml && hasPdf
      ? "cfdi_downloaded"
      : status === "completed" && hasXml && !hasPdf
      ? "cfdi_xml_downloaded_pdf_missing"
      : result?.reason ?? (executionError ? "b3_execution_failed" : "b3_unresolved");

  return {
    ok: result?.ok === true && !executionError,
    providerMode: "b3_browseruse",
    status,
    reason,
    statusMessage:
      reason === "cfdi_downloaded"
        ? "Factura generada correctamente. XML y PDF guardados."
        : reason === "cfdi_xml_downloaded_pdf_missing"
        ? "Factura generada: XML guardado. PDF no disponible o no descargado."
        : result?.statusMessage ?? result?.status_message ?? executionError ?? "B3 no pudo completar el flujo",
    currentUrl: result?.currentUrl ?? result?.current_url ?? null,
    xmlPath: xml?.path ?? null,
    pdfPath: pdf?.path ?? null,
    xmlUrl: null,
    pdfUrl: null,
    downloads,
    downloadedXml: hasXml || result?.downloadedXml || result?.downloaded_xml || false,
    downloadedPdf: hasPdf || false,
    artifacts: {
      ...(result?.artifacts ?? {}),
      fixturePath,
    },
    trace: result?.trace ?? null,
    usage: normalizeB3Usage(result?.usage ?? result?.trace?.usage),
    structuredResult: result?.structuredResult ?? null,
    learnedTemplateSave: result?.learnedTemplateSave ?? null,
    b3ToABridge: result?.b3ToABridge ?? null,
    command,
    stderr: stderr ? String(stderr).slice(-4000) : null,
    executionError: executionError ?? null,
    raw: result,
  };
}

function normalizeB3Usage(usage) {
  if (!usage || typeof usage !== "object") return null;

  return {
    promptTokens: nonNegativeNumber(usage.promptTokens),
    cachedPromptTokens: nonNegativeNumber(usage.cachedPromptTokens),
    completionTokens: nonNegativeNumber(usage.completionTokens),
    totalTokens: nonNegativeNumber(usage.totalTokens),
    entryCount: nonNegativeNumber(usage.entryCount),
    estimatedCostUsd:
      usage.estimatedCostUsd === null || usage.estimatedCostUsd === undefined
        ? null
        : nonNegativeNumber(usage.estimatedCostUsd),
    costEstimationRequested: usage.costEstimationRequested === true,
    costCalculated: usage.costCalculated === true,
    pricingSource: String(usage.pricingSource ?? "tokens_only").slice(0, 120),
    byModel: usage.byModel && typeof usage.byModel === "object" ? usage.byModel : {},
  };
}

function nonNegativeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}

function normalizeB3Status(status) {
  if (status === "completed") {
    return "completed";
  }

  if (status === "blocked" || status === "needs_user_action") {
    return "needs_user_action";
  }

  if (status === "failed") {
    return "needs_user_action";
  }

  return status ?? "needs_user_action";
}

async function persistLearnedTemplateCandidate(result) {
  const candidatePath = result?.learnedTemplateSave?.path;

  if (!candidatePath) {
    return result;
  }

  try {
    const document = JSON.parse(await readFile(candidatePath, "utf8"));
    const shared = await publishTemplateCandidateDocument({
      document,
      sourcePath: candidatePath,
    });

    result.learnedTemplateSave = {
      ...result.learnedTemplateSave,
      sharedPath: shared?.path ?? null,
      sharedStatus: shared?.status ?? null,
    };
    result.learningPersistence = {
      ok: true,
      sharedPath: shared?.path ?? null,
      candidateStatus: document.status ?? null,
    };
  } catch (error) {
    // Learning persistence must never invalidate a real CFDI already downloaded by B3.
    result.learningPersistence = {
      ok: false,
      error: String(error?.message ?? error ?? "unknown_error").slice(0, 1_000),
    };
  }

  return result;
}

function parseJsonFromStdout(stdout) {
  const text = String(stdout ?? "").trim();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");

    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    }

    throw new Error(`B3 did not return JSON: ${text.slice(0, 500)}`);
  }
}

function buildPortalCandidates({ job = {}, extracted = {}, template = null }) {
  const candidates = [];
  const add = (url, source) => {
    if (!url) {
      return;
    }

    let safeUrl;
    try {
      safeUrl = validateExternalUrlStructure(url).href;
    } catch {
      return;
    }

    if (candidates.some((candidate) => candidate.url === safeUrl)) {
      return;
    }

    candidates.push({
      url: safeUrl,
      source,
      confidence: source === "template" ? 0.9 : 0.8,
    });
  };

  for (const candidate of toArray(job.portalCandidates)) {
    add(candidate?.url, candidate?.source ?? "job.portalCandidates");
  }

  add(job.aiPortalUrl, "job.aiPortalUrl");
  add(job.portalCandidateUrl, "job.portalCandidateUrl");
  add(job.portalUrl, "job.portalUrl");
  add(extracted.portalUrl, "extracted.portalUrl");
  add(template?.portalUrl, "template");

  for (const url of toArray(extracted.ocrCandidates?.portalUrls)) {
    add(url, "ocrCandidates.portalUrls");
  }

  return candidates;
}

function normalizeLocalTicketPath(value) {
  if (typeof value !== "string") {
    return null;
  }

  if (/^[a-zA-Z]:[\\/]/.test(value)) {
    return value;
  }

  return null;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function sanitizePathSegment(value) {
  return String(value ?? "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}
