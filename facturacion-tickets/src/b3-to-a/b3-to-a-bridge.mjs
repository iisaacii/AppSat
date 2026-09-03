import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { compileAndSaveB3Candidate } from "../../compiler_GPT/lib/compile-save.mjs";
import { readJson } from "../../compiler_GPT/lib/browser-use-history.mjs";
import { publishTemplateCandidateDocument } from "../portals/template-candidates.mjs";
import { resolveTemplateFields } from "../portals/template-fields.mjs";
import { runPortalTemplate } from "../portals/template-runner.mjs";

export async function bridgeB3CandidateToA({
  candidatePath,
  fixturePath = null,
  profilePath = "data/tax-profiles/sample.json",
  historyPath = null,
  replay = false,
  replayCount = 2,
  approveFinalSubmit = false,
  dryRun = false,
  markReplay = true,
  outDir = "data/portal-template-candidates",
}) {
  const sourceCandidateDocument = await readJson(candidatePath);
  const persistenceErrors = [];
  const sourcePublication = await publishDocumentSafely({
    document: sourceCandidateDocument,
    sourcePath: candidatePath,
    dryRun,
  });

  if (sourcePublication.error) {
    persistenceErrors.push({ stage: "source_candidate", error: sourcePublication.error });
  }

  let compileResult;

  try {
    compileResult = await compileAndSaveB3Candidate({
      candidatePath,
      historyPath,
      outDir,
      dryRun,
    });
  } catch (error) {
    return {
      ok: false,
      stage: "compile_failed",
      bridge: "b3_to_a",
      candidatePath,
      sourceCandidate: sourcePublication.result,
      persistenceErrors,
      error: summarizeError(error),
    };
  }

  const compiledPath = compileResult.outputPath;
  const compiledDocument = compileResult.document;
  let replayResult = null;
  let replayReview = null;
  const replayAttempts = [];
  let compiledPublication = { result: null, error: null };

  if (!dryRun) {
    const persistedDocument = JSON.parse(await readFile(compiledPath, "utf8"));
    compiledPublication = await publishDocumentSafely({
      document: persistedDocument,
      sourcePath: compiledPath,
      dryRun,
    });

    if (compiledPublication.error) {
      persistenceErrors.push({ stage: "compiled_candidate", error: compiledPublication.error });
    }
  }

  if (replay && !dryRun) {
    if (!fixturePath) {
      replayResult = {
        ok: false,
        status: "failed",
        reason: "fixture_required_for_replay",
      };
      replayAttempts.push(replayResult);
    } else {
      const attempts = normalizeReplayCount(replayCount);

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          replayResult = await replayCompiledCandidate({
            compiledDocument,
            fixturePath,
            profilePath,
            approveFinalSubmit,
          });
        } catch (error) {
          replayResult = {
            ok: false,
            status: "failed",
            reason: "replay_execution_failed",
            error: summarizeError(error),
          };
        }

        replayAttempts.push(replayResult);

        if (markReplay) {
          try {
            replayReview = await writeReplayReview({ compiledPath, replayResult });
            const reviewedDocument = JSON.parse(await readFile(compiledPath, "utf8"));
            compiledPublication = await publishDocumentSafely({
              document: reviewedDocument,
              sourcePath: compiledPath,
              dryRun,
            });

            if (compiledPublication.error) {
              persistenceErrors.push({ stage: "replay_review", error: compiledPublication.error });
            }
          } catch (error) {
            replayReview = {
              ok: false,
              error: summarizeError(error),
            };
          }
        }

        if (!isReplayPromotionSuccess(replayResult)) {
          break;
        }
      }
    }

    if (markReplay && !replayReview) {
      try {
        replayReview = await writeReplayReview({ compiledPath, replayResult });
        const reviewedDocument = JSON.parse(await readFile(compiledPath, "utf8"));
        compiledPublication = await publishDocumentSafely({
          document: reviewedDocument,
          sourcePath: compiledPath,
          dryRun,
        });

        if (compiledPublication.error) {
          persistenceErrors.push({ stage: "replay_review", error: compiledPublication.error });
        }
      } catch (error) {
        replayReview = { ok: false, error: summarizeError(error) };
      }
    }
  }

  return {
    ok: true,
    stage: replayResult
      ? isReplayPromotionSuccess(replayResult)
        ? "replay_completed"
        : "compiled_replay_failed"
      : "compiled",
    bridge: "b3_to_a",
    candidatePath,
    compiledPath,
    compile: compileResult.summary,
    replay: replayResult,
    replayAttempts: replayAttempts.map(summarizeReplayAttempt),
    replayReview,
    sourceCandidate: sourcePublication.result,
    sharedCandidate: compiledPublication.result,
    persistenceErrors,
  };
}

async function publishDocumentSafely({ document, sourcePath, dryRun }) {
  if (dryRun) {
    return { result: null, error: null };
  }

  try {
    return {
      result: await publishTemplateCandidateDocument({ document, sourcePath }),
      error: null,
    };
  } catch (error) {
    return {
      result: null,
      error: summarizeError(error),
    };
  }
}

function summarizeError(error) {
  return String(error?.message ?? error ?? "unknown_error").slice(0, 1_000);
}

export async function replayCompiledCandidate({
  compiledDocument,
  fixturePath,
  profilePath = "data/tax-profiles/sample.json",
  approveFinalSubmit = false,
}) {
  const fixture = await readJson(fixturePath);
  const taxProfile = fixture.taxProfile ?? (await readJson(profilePath).catch(() => ({})));
  const template = compiledDocument.template;
  const context = {
    ...fixture,
    ...(fixture.ocrCandidates ?? {}),
    taxProfile,
    id: `b3_to_a_replay_${template.id}`,
    portalFinalSubmitApproved: approveFinalSubmit === true,
  };
  const fieldResolution = resolveTemplateFields(template, context);

  if (fieldResolution.missingFields.length) {
    return {
      ok: false,
      status: "failed",
      reason: "missing_fields",
      missingFields: fieldResolution.missingFields,
    };
  }

  const result = await runPortalTemplate(template, {
    ...context,
    ...fieldResolution.resolved,
  });

  return {
    ok: true,
    status: classifyReplayStatus(result),
    reason:
      result.reason ?? (result.xmlUrl || result.pdfUrl || result.xmlPath || result.pdfPath ? "replay_completed" : "replay_finished"),
    result,
  };
}

async function writeReplayReview({ compiledPath, replayResult }) {
  const raw = JSON.parse(await readFile(compiledPath, "utf8"));
  const replayStatus = replayResult?.status ?? "not_run";
  const nextStatus = chooseCandidateStatus(raw.status, replayResult);
  const successfulReplayCount = nextStatus === "active_lab" ? 2 : nextStatus === "replay_passed_1" ? 1 : 0;
  const replayRun = {
    at: new Date().toISOString(),
    status: replayStatus,
    reason: replayResult?.reason ?? null,
    successfulForPromotion: isReplayPromotionSuccess(replayResult),
    result: summarizeReplayResult(replayResult?.result),
  };
  const updated = {
    ...raw,
    status: nextStatus,
    replay: {
      ...(raw.replay ?? {}),
      lastRunAt: replayRun.at,
      status: replayStatus,
      reason: replayResult?.reason ?? null,
      result: summarizeReplayResult(replayResult?.result),
      runs: [...(Array.isArray(raw.replay?.runs) ? raw.replay.runs : []), replayRun].slice(-4),
    },
    promotion: {
      ...(raw.promotion ?? {}),
      readyForActive: nextStatus === "active_lab",
      successfulReplayCount,
      requiredBeforeActive:
        nextStatus === "replay_passed_1"
          ? ["second_replay_without_llm", "validate_cfdi_xml_pdf"]
          : nextStatus === "active_lab"
            ? []
            : raw.promotion?.requiredBeforeActive,
    },
  };

  await writeFile(compiledPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");

  return {
    path: compiledPath,
    previousStatus: raw.status ?? "compiled",
    status: nextStatus,
    successfulReplayCount,
  };
}

export function chooseCandidateStatus(currentStatus, replayResult) {
  if (!isReplayPromotionSuccess(replayResult)) {
    return currentStatus === "replay_passed_1" ? "compiled" : currentStatus ?? "compiled";
  }

  if (["active", "active_lab"].includes(currentStatus)) {
    return currentStatus;
  }

  if (currentStatus === "replay_passed_1") {
    return "active_lab";
  }

  return "replay_passed_1";
}

export function isReplayPromotionSuccess(replayResult) {
  if (!replayResult?.ok || replayResult.status !== "completed") {
    return false;
  }

  const result = replayResult.result ?? {};
  return Boolean(result.xmlPath || result.xmlUrl);
}

function classifyReplayStatus(result) {
  if (result?.xmlUrl || result?.pdfUrl || result?.xmlPath || result?.pdfPath) {
    return "completed";
  }

  if (result?.safeStop) {
    return "safe_stop";
  }

  return "finished";
}

function summarizeReplayResult(result) {
  if (!result) {
    return null;
  }

  return {
    status: result.status ?? null,
    reason: result.reason ?? null,
    statusMessage: result.statusMessage ?? null,
    safeStop: result.safeStop ?? null,
    xmlUrl: result.xmlUrl ?? null,
    pdfUrl: result.pdfUrl ?? null,
    xmlPath: result.xmlPath ?? null,
    pdfPath: result.pdfPath ?? null,
    artifacts: result.artifacts ?? null,
  };
}

function summarizeReplayAttempt(result) {
  return {
    ok: result?.ok === true,
    status: result?.status ?? null,
    reason: result?.reason ?? null,
    successfulForPromotion: isReplayPromotionSuccess(result),
    result: summarizeReplayResult(result?.result),
  };
}

function normalizeReplayCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(2, Math.floor(parsed))) : 2;
}

export function displayBridgeSummary(result) {
  return {
    ok: result.ok,
    bridge: result.bridge,
    candidate: basename(result.candidatePath),
    compiled: basename(result.compiledPath),
    compile: result.compile,
    replayStatus: result.replay?.status ?? null,
    replayReason: result.replay?.reason ?? null,
  };
}
