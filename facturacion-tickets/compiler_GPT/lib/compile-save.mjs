import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { compileB3CandidateToATemplate } from "./template-compiler.mjs";
import { getHistoryPath, readJson } from "./browser-use-history.mjs";

export async function compileAndSaveB3Candidate({
  candidatePath,
  historyPath = null,
  out = null,
  outDir = "data/portal-template-candidates",
  dryRun = false,
  options = {},
}) {
  if (!candidatePath) {
    throw new Error("Missing candidatePath.");
  }

  const candidateDocument = await readJson(candidatePath);
  const resolvedHistoryPath = getHistoryPath(candidateDocument, historyPath);
  const historyDocument = resolvedHistoryPath ? await readJson(resolvedHistoryPath).catch(() => null) : null;
  const compiled = compileB3CandidateToATemplate({
    candidateDocument,
    historyDocument,
    options,
  });
  const document = buildCompiledCandidateDocument({
    sourceCandidatePath: candidatePath,
    historyPath: resolvedHistoryPath,
    candidateDocument,
    compiled,
  });
  const outputPath = resolveOutputPath({ out, outDir, candidatePath, document });

  if (!dryRun) {
    await mkdir(resolve(outputPath, ".."), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  }

  return {
    outputPath,
    document,
    summary: summarizeCompiledDocument(document),
  };
}

export function buildCompiledCandidateDocument({ sourceCandidatePath, historyPath, candidateDocument, compiled }) {
  return {
    status: compiled.status,
    learningState: compiled.learningState,
    source: {
      providerMode: "compiler_GPT",
      parentProviderMode: candidateDocument.source?.providerMode ?? null,
      parentTemplateId: candidateDocument.template?.id ?? null,
      parentCandidatePath: normalizePath(sourceCandidatePath),
      historyPath: historyPath ? normalizePath(historyPath) : null,
      createdAt: new Date().toISOString(),
    },
    validation: compiled.validation,
    promotion: compiled.promotion,
    compileReport: compiled.compileReport,
    template: compiled.template,
  };
}

export function resolveCompiledOutputPath({ out = null, outDir = "data/portal-template-candidates", candidatePath, document }) {
  return resolveOutputPath({ out, outDir, candidatePath, document });
}

export function summarizeCompiledDocument(document) {
  return {
    status: document.status,
    learningState: document.learningState,
    validation: document.validation,
    templateId: document.template?.id ?? null,
    portalUrl: document.template?.portalUrl ?? null,
    steps: document.template?.steps?.length ?? 0,
    requiredFields: document.template?.requiredFields?.length ?? 0,
    compiledActions: document.compileReport?.compiledActions?.length ?? 0,
    unresolvedActions: document.compileReport?.unresolvedActions?.length ?? 0,
    stopReason: document.compileReport?.stopReason ?? null,
    selectorConfidenceAvg: document.compileReport?.selectorConfidenceAvg ?? null,
  };
}

function resolveOutputPath({ out, outDir, candidatePath, document }) {
  if (out) {
    return resolve(out);
  }

  const outputDir = resolve(outDir);
  const base = basename(candidatePath).replace(/\.candidate\.json$/i, "");
  const suffix = document.status === "compiled" ? "compiled-gpt" : "draft-compiled-gpt";

  return resolve(outputDir, `${base}-${suffix}.candidate.json`);
}

function normalizePath(path) {
  return String(path ?? "").replaceAll("\\", "/");
}
