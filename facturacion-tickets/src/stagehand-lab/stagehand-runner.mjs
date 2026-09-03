import {
  getBrowserbaseApiKey,
  getBrowserbaseProjectId,
  getBrowserbaseRegion,
  getGeminiApiKey,
  getStagehandCacheDir,
  getStagehandEnv,
  getStagehandMaxSteps,
  getStagehandModel,
  shouldRecordBrowserbaseSession,
  shouldUseBrowserbaseAdvancedStealth,
  shouldUseBrowserbaseCaptchaSolving,
  shouldUseBrowserbaseProxies,
} from "../config/env.mjs";
import { extractVisiblePageState } from "../b2-lab/page-state-extractor.mjs";
import { classifyB2PageState } from "../b2-lab/b2-semantic-validation.mjs";
import { writeStagehandCache } from "./cache.mjs";
import { validateCfdiDownload } from "./cfdi-validator.mjs";
import {
  ensureStagehandPortalState,
  getStagehandStatePathForDisplay,
  readStagehandPortalState,
  recordStagehandOutcome,
} from "./registry.mjs";
import { captureStagehandArtifacts, replayStagehandCache } from "./replay-runner.mjs";

export async function runStagehandLab({
  mode = "learn",
  job,
  extracted,
  taxProfile = job?.taxProfile,
  fiscalCompliance = job?.fiscalCompliance,
  portalUrl,
  template = null,
}) {
  const resolvedPortalUrl = resolvePortalUrl({ job, extracted, portalUrl, template });
  const context = buildStagehandContext({
    job,
    extracted,
    taxProfile,
    fiscalCompliance,
    portalUrl: resolvedPortalUrl,
  });

  if (!resolvedPortalUrl) {
    return {
      status: "needs_user_action",
      reason: "stagehand_portal_url_missing",
      statusMessage: "Stagehand no puede iniciar sin URL candidata del portal",
      portalLearningState: "blocked",
      aiNavigationResult: {
        providerMode: "stagehand",
        mode,
        reason: "stagehand_portal_url_missing",
      },
    };
  }

  if (mode !== "replay" && !getGeminiApiKey()) {
    return {
      status: "needs_user_action",
      reason: "stagehand_provider_not_configured",
      statusMessage: "Stagehand requiere GEMINI_API_KEY, GOOGLE_API_KEY o GOOGLE_GENERATIVE_AI_API_KEY para aprender",
      portalUrl: context.portalUrl,
      portalLearningState: "unknown",
      aiNavigationResult: {
        providerMode: "stagehand",
        provider: "stagehand",
        mode,
        status: "needs_user_action",
        reason: "stagehand_provider_not_configured",
        portalLearningState: "unknown",
      },
    };
  }

  const existingState = await readStagehandPortalState({
    rfcEmisor: context.rfcEmisor,
    portalUrl: resolvedPortalUrl,
  });

  if (mode === "replay" && !existingState) {
    return {
      status: "needs_user_action",
      reason: "stagehand_cache_missing",
      statusMessage: "No hay cache Stagehand para reproducir",
      portalUrl: context.portalUrl,
      portalLearningState: "unknown",
      stagehandCacheStatus: "missing",
      aiNavigationResult: {
        providerMode: "stagehand",
        provider: "stagehand",
        mode,
        status: "needs_user_action",
        reason: "stagehand_cache_missing",
        portalLearningState: "unknown",
        stagehandCacheStatus: "missing",
      },
    };
  }

  const state = existingState ?? (await ensureStagehandPortalState({
    rfcEmisor: context.rfcEmisor,
    portalUrl: resolvedPortalUrl,
  }));

  if (mode === "replay") {
    return runStagehandReplay({
      state,
      context,
      job,
      mode,
    });
  }

  if (mode === "repair") {
    const repaired = await runStagehandLearn({
      state: { ...state, status: "degraded" },
      context,
      job,
      mode: "repair",
    });

    return repaired;
  }

  return runStagehandLearn({
    state,
    context,
    job,
    mode: "learn",
  });
}

export async function runStagehandIfUseful({ job, extracted, taxProfile, fiscalCompliance, portalUrl, template }) {
  const resolvedPortalUrl = resolvePortalUrl({ job, extracted, portalUrl, template });

  if (!resolvedPortalUrl) {
    return null;
  }

  const state = await readStagehandPortalState({
    rfcEmisor: extracted?.rfcEmisor ?? job?.rfcEmisor,
    portalUrl: resolvedPortalUrl,
  });

  if (state?.status === "active" || state?.status === "candidate_cached") {
    const replay = await runStagehandLab({
      mode: "replay",
      job,
      extracted,
      taxProfile,
      fiscalCompliance,
      portalUrl: resolvedPortalUrl,
      template,
    });

    if (replay.status === "completed" || replay.reason === "stagehand_final_submit_approval_required") {
      return replay;
    }

    if (state.status === "active") {
      return runStagehandLab({
        mode: "repair",
        job,
        extracted,
        taxProfile,
        fiscalCompliance,
        portalUrl: resolvedPortalUrl,
        template,
      });
    }
  }

  if (!state || ["unknown", "learning", "degraded"].includes(state.status)) {
    return runStagehandLab({
      mode: state?.status === "degraded" ? "repair" : "learn",
      job,
      extracted,
      taxProfile,
      fiscalCompliance,
      portalUrl: resolvedPortalUrl,
      template,
    });
  }

  return null;
}

async function runStagehandReplay({ state, context, job, mode }) {
  const replay = await replayStagehandCache({
    cache: state.cache,
    context,
    job,
    mode,
  });

  if (replay.reason === "stagehand_cache_missing") {
    return {
      ...replay,
      portalUrl: context.portalUrl,
      portalLearningState: state.status,
      aiNavigationResult: {
        ...(replay.aiNavigationResult ?? {}),
        providerMode: "stagehand",
        provider: "stagehand",
        mode,
        portalLearningState: state.status,
      },
    };
  }

  const cfdiValidationResult =
    replay.xmlPath && replay.status === "completed"
      ? await validateCfdiDownload({
          xmlPath: replay.xmlPath,
          expected: {
            rfcEmisor: context.rfcEmisor,
            rfcReceptor: context.rfcReceptor,
            monto: context.monto,
            fecha: context.fecha,
          },
        })
      : null;
  const completed = replay.status === "completed" && (!cfdiValidationResult || cfdiValidationResult.ok);
  const promotionEligible = completed;
  const nextState = await recordStagehandOutcome({
    rfcEmisor: context.rfcEmisor,
    portalUrl: context.portalUrl,
    mode,
    success: completed || replay.reason === "stagehand_final_submit_approval_required",
    reason: replay.reason,
    evidence: replay.artifacts ? [replay.artifacts] : [],
    trace: replay.stagehandTrace ?? null,
    cache: state.cache,
    cfdiValidationResult,
    promotionEligible,
  });

  return {
    ...replay,
    portalUrl: context.portalUrl,
    portalLearningState: nextState.status,
    stagehandCacheStatus: replay.stagehandCacheStatus ?? "replayed",
    cfdiValidationResult,
    aiNavigationResult: {
      ...(replay.aiNavigationResult ?? {}),
      providerMode: "stagehand",
      provider: "stagehand",
      mode,
      portalLearningState: nextState.status,
      stagehandCacheStatus: replay.stagehandCacheStatus ?? "replayed",
      cfdiValidationResult,
    },
  };
}

async function runStagehandLearn({ state, context, job, mode }) {
  const trace = {
    mode,
    model: getStagehandModel(),
    startedAt: new Date().toISOString(),
    observedActions: [],
    pageSnapshots: [],
    stagehandActs: [],
    executedActions: [],
    failedActions: [],
  };
  let stagehand = null;

  try {
    const stagehandModule = await import("@browserbasehq/stagehand");
    const apiKey = getGeminiApiKey();

    if (!apiKey) {
      return buildProviderNotConfiguredResult({ context, mode, state });
    }

    const Stagehand = stagehandModule.Stagehand ?? stagehandModule.default?.Stagehand;
    const stagehandEnv = normalizeStagehandEnv(getStagehandEnv());
    stagehand = new Stagehand({
      env: stagehandEnv,
      ...buildBrowserbaseStagehandOptions(stagehandEnv, context),
      model: {
        modelName: normalizeStagehandModel(getStagehandModel()),
        apiKey,
      },
      ...(stagehandEnv === "LOCAL"
        ? {
            localBrowserLaunchOptions: {
              headless: process.env.HEADLESS !== "false",
              acceptDownloads: true,
              ignoreHTTPSErrors: true,
            },
          }
        : {}),
      cacheDir: `${getStagehandCacheDir()}/native`,
      serverCache: stagehandEnv === "BROWSERBASE",
      verbose: 0,
      disablePino: true,
    });
    await stagehand.init();
    let page = stagehand.context.pages()[0] ?? (await stagehand.context.newPage());
    await page.setViewportSize(1365, 900).catch(() => {});

    await page.goto(context.portalUrl, {
      waitUntil: "domcontentloaded",
      timeoutMs: 45000,
    });
    trace.executedActions.push({
      type: "goto",
      url: context.portalUrl,
    });

    page = await refreshActiveStagehandPage(stagehand, page);
    page = await runSafeStagehandTransitionProbe({ stagehand, page, context, trace, label: "initial" });
    const observed = shouldSkipStagehandObserve() ? [] : await safeObserve(stagehand, page, buildObservePrompt(context));
    trace.observedActions.push(...observed);

    const acts = shouldRunStagehandTransitionsOnly() ? [] : buildStagehandInstructionPlan(context, job);

    for (const instruction of acts.slice(0, getStagehandMaxSteps())) {
      page = await refreshActiveStagehandPage(stagehand, page);
      page = await runSafeStagehandTransitionProbe({ stagehand, page, context, trace, label: "before_stagehand_act" });

      const actResult = await runStagehandActWithTimeout(stagehand, instruction, {
        page,
        timeout: getStagehandActTimeoutMs(),
        serverCache: false,
      });
      trace.stagehandActs.push({
        instruction,
        success: actResult?.success ?? null,
        message: actResult?.message ?? null,
        actionDescription: actResult?.actionDescription ?? null,
        cacheStatus: actResult?.cacheStatus ?? null,
        actionCount: actResult?.actions?.length ?? 0,
      });
      trace.executedActions.push(...convertStagehandActionsToTrace(actResult?.actions, instruction));
      if (actResult?.timedOut) {
        trace.failedActions.push({
          instruction,
          reason: "stagehand_act_timeout",
          timeoutMs: getStagehandActTimeoutMs(),
        });
        break;
      }
      page = await refreshActiveStagehandPage(stagehand, page);
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(800);
      page = await runSafeStagehandTransitionProbe({ stagehand, page, context, trace, label: "after_stagehand_act" });
    }

    const learnedActions = buildLearnedActions({
      context,
      observedActions: trace.observedActions,
      executedActions: trace.executedActions,
      includeFinalSubmit: true,
    });
    const cache = await writeStagehandCache({
      rfcEmisor: context.rfcEmisor,
      portalUrl: context.portalUrl,
      actions: learnedActions,
      metadata: {
        learnedBy: "stagehand",
        mode,
        model: getStagehandModel(),
        generatedFrom: "observe_act_trace",
      },
    });
    page = await refreshActiveStagehandPage(stagehand, page);
    const artifacts = await captureStagehandArtifacts(page, {
      context,
      prefix: `${state.key}-${mode}`,
    }).catch(() => null);
    const finalGuard = buildStagehandLabFinalGuard(job);

    if (!finalGuard.ready) {
      const readiness = await inspectStagehandFinalReadiness(page);

      if (!readiness.ready) {
        const nextState = await recordStagehandOutcome({
          rfcEmisor: context.rfcEmisor,
          portalUrl: context.portalUrl,
          mode,
          success: false,
          reason: "stagehand_learning_incomplete",
          evidence: artifacts ? [artifacts] : [],
          trace: {
            ...trace,
            finalSubmitReadiness: readiness,
          },
          cache,
          promotionEligible: false,
        });

        return {
          status: "needs_user_action",
          reason: "stagehand_learning_incomplete",
          statusMessage: "Stagehand no llego al boton final habilitado; se guardo evidencia parcial",
          portalUrl: context.portalUrl,
          portalLearningState: nextState.status,
          stagehandCacheStatus: "partial",
          stagehandTrace: {
            ...trace,
            finalSubmitReadiness: readiness,
          },
          finalSubmitGuard: finalGuard,
          artifacts,
          aiNavigationResult: {
            providerMode: "stagehand",
            provider: "stagehand",
            mode,
            status: "needs_user_action",
            reason: "stagehand_learning_incomplete",
            statusMessage: "Stagehand no llego al boton final habilitado; se guardo evidencia parcial",
            portalLearningState: nextState.status,
            stagehandCacheStatus: "partial",
            finalSubmitGuard: finalGuard,
            finalSubmitReadiness: readiness,
            stagehandTrace: trace,
            artifacts,
          },
        };
      }

      const nextState = await recordStagehandOutcome({
        rfcEmisor: context.rfcEmisor,
        portalUrl: context.portalUrl,
        mode,
        success: true,
        reason: "stagehand_final_submit_approval_required",
        evidence: artifacts ? [artifacts] : [],
        trace,
        cache,
        promotionEligible: false,
      });

      return {
        status: "needs_user_action",
        reason: "stagehand_final_submit_approval_required",
        statusMessage: "Stagehand dejo el portal listo y se detuvo antes de emitir por guardas",
        safeStop: true,
        portalUrl: context.portalUrl,
        portalLearningState: nextState.status,
        stagehandCacheStatus: "written",
        stagehandTrace: trace,
        finalSubmitGuard: finalGuard,
        artifacts,
        aiNavigationResult: {
          providerMode: "stagehand",
          provider: "stagehand",
          mode,
          status: "needs_user_action",
          reason: "stagehand_final_submit_approval_required",
          statusMessage: "Stagehand dejo el portal listo y se detuvo antes de emitir por guardas",
          portalLearningState: nextState.status,
          stagehandCacheStatus: "written",
          finalSubmitGuard: finalGuard,
          stagehandTrace: trace,
          artifacts,
        },
      };
    }

    const downloadResult = await executeStagehandFinalSubmitAndDownloads({
      stagehand,
      page,
      context,
      trace,
    });
    const cfdiValidationResult =
      downloadResult.xmlPath && downloadResult.status === "completed"
        ? await validateCfdiDownload({
            xmlPath: downloadResult.xmlPath,
            expected: {
              rfcEmisor: context.rfcEmisor,
              rfcReceptor: context.rfcReceptor,
              monto: context.monto,
              fecha: context.fecha,
            },
          })
        : null;
    const completed = downloadResult.status === "completed" && (!cfdiValidationResult || cfdiValidationResult.ok);
    const nextState = await recordStagehandOutcome({
      rfcEmisor: context.rfcEmisor,
      portalUrl: context.portalUrl,
      mode,
      success: completed,
      reason: downloadResult.reason,
      evidence: downloadResult.artifacts ? [downloadResult.artifacts] : artifacts ? [artifacts] : [],
      trace,
      cache,
      cfdiValidationResult,
    });

    return {
      ...downloadResult,
      portalUrl: context.portalUrl,
      portalLearningState: nextState.status,
      stagehandCacheStatus: "written",
      stagehandTrace: trace,
      cfdiValidationResult,
      aiNavigationResult: {
        providerMode: "stagehand",
        provider: "stagehand",
        mode,
        status: downloadResult.status,
        reason: downloadResult.reason,
        statusMessage: downloadResult.statusMessage,
        portalLearningState: nextState.status,
        stagehandCacheStatus: "written",
        stagehandTrace: trace,
        cfdiValidationResult,
        artifacts: downloadResult.artifacts ?? artifacts,
      },
    };
  } catch (error) {
    const blockReason = classifyStagehandBlockReason(error);
    const nextState = await recordStagehandOutcome({
      rfcEmisor: context.rfcEmisor,
      portalUrl: context.portalUrl,
      mode,
      success: false,
      reason: "stagehand_learning_failed",
      error: error.message,
      trace,
      cache: state.cache,
      blockReason,
    });

    return {
      status: "needs_user_action",
      reason: blockReason ?? "stagehand_learning_failed",
      statusMessage: `Stagehand no pudo completar el aprendizaje: ${error.message}`,
      portalUrl: context.portalUrl,
      portalLearningState: nextState.status,
      stagehandTrace: trace,
      error: error.message,
      aiNavigationResult: {
        providerMode: "stagehand",
        provider: "stagehand",
        mode,
        status: "needs_user_action",
        reason: blockReason ?? "stagehand_learning_failed",
        statusMessage: `Stagehand no pudo completar el aprendizaje: ${error.message}`,
        portalLearningState: nextState.status,
        stagehandTrace: trace,
      },
    };
  } finally {
    if (stagehand) {
      await withTimeout(
        () => stagehand.close({ force: true }),
        Number(process.env.STAGEHAND_CLOSE_TIMEOUT_MS ?? 15000),
        "stagehand_close_timeout",
      ).catch(() => {});
    }
  }
}

function buildProviderNotConfiguredResult({ context, mode, state }) {
  return {
    status: "needs_user_action",
    reason: "stagehand_provider_not_configured",
    statusMessage: "Stagehand requiere GEMINI_API_KEY, GOOGLE_API_KEY o GOOGLE_GENERATIVE_AI_API_KEY para aprender",
    portalUrl: context.portalUrl,
    portalLearningState: state.status,
    aiNavigationResult: {
      providerMode: "stagehand",
      provider: "stagehand",
      mode,
      status: "needs_user_action",
      reason: "stagehand_provider_not_configured",
    },
  };
}

async function safeObserve(stagehand, page, instruction) {
  const actions = await withTimeout(
    () =>
      stagehand.observe(instruction, {
        page,
        timeout: getStagehandActTimeoutMs(),
        serverCache: false,
      }),
    getStagehandActTimeoutMs() + 5000,
    "stagehand_observe_timeout",
  ).catch(() => []);

  return Array.from(actions ?? []).map((action) => ({
    selector: action.selector ?? null,
    description: action.description ?? null,
    method: action.method ?? null,
    arguments: action.arguments ?? [],
  }));
}

async function runStagehandActWithTimeout(stagehand, instruction, options) {
  return withTimeout(
    () => stagehand.act(instruction, options),
    (options?.timeout ?? getStagehandActTimeoutMs()) + 5000,
    "stagehand_act_timeout",
  ).catch((error) => ({
    success: false,
    timedOut: error?.message === "stagehand_act_timeout",
    message: error?.message ?? String(error),
    actions: [],
  }));
}

function getStagehandActTimeoutMs() {
  const value = Number(process.env.STAGEHAND_ACT_TIMEOUT_MS ?? 45000);
  return Number.isFinite(value) && value >= 10000 ? value : 45000;
}

function shouldSkipStagehandObserve() {
  return process.env.STAGEHAND_SKIP_OBSERVE === "true" || shouldRunStagehandTransitionsOnly();
}

function shouldRunStagehandTransitionsOnly() {
  return process.env.STAGEHAND_TRANSITIONS_ONLY === "true";
}

async function withTimeout(fn, timeoutMs, message) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function refreshActiveStagehandPage(stagehand, fallbackPage) {
  const pages = stagehand.context.pages();
  const page = pages.at(-1) ?? stagehand.page ?? fallbackPage;
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500).catch(() => {});
  return page;
}

async function runSafeStagehandTransitionProbe({ stagehand, page, context, trace, label }) {
  let activePage = await refreshActiveStagehandPage(stagehand, page);

  for (let index = 0; index < 3; index += 1) {
    const snapshot = await captureStagehandPageSnapshot(activePage, label).catch(() => null);
    if (snapshot) {
      trace.pageSnapshots.push(snapshot);
      if (["technical_block", "captcha"].includes(snapshot.classification?.pageKind)) {
        return activePage;
      }
    }

    const clicked = await clickSafeInvoiceTransition(activePage);
    if (!clicked) {
      return activePage;
    }

    trace.executedActions.push({
      type: "safeTransition",
      label,
      text: clicked.text,
      urlBefore: clicked.urlBefore,
      urlAfter: null,
      reason: clicked.reason,
    });

    await activePage.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
    await activePage.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await activePage.waitForTimeout(1500);
    activePage = await refreshActiveStagehandPage(stagehand, activePage);
    trace.executedActions[trace.executedActions.length - 1].urlAfter = safePageUrl(activePage, context.portalUrl);
  }

  return activePage;
}

async function captureStagehandPageSnapshot(page, label) {
  const pageState = await extractVisiblePageState(page);
  return {
    label,
    url: safePageUrl(page),
    title: pageState.title ?? null,
    classification: classifyB2PageState(pageState),
    controls: {
      inputs: pageState.inputs?.length ?? 0,
      selects: pageState.selects?.length ?? 0,
      buttons: pageState.buttons?.length ?? 0,
      links: pageState.links?.length ?? 0,
    },
    securitySignals: pageState.securitySignals ?? [],
    visibleTextPreview: String(pageState.visibleText ?? "").slice(0, 700),
  };
}

async function clickSafeInvoiceTransition(page) {
  return page.evaluate(() => {
    const normalize = (value) =>
      String(value ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    };
    const disabled = (element) =>
      element.disabled === true ||
      element.getAttribute("disabled") !== null ||
      element.getAttribute("aria-disabled") === "true";
    const textFor = (element) =>
      [
        element.innerText,
        element.textContent,
        element.value,
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("href"),
      ]
        .filter(Boolean)
        .join(" ");
    const transitionTargets = [
      { pattern: /ir al portal de facturacion/, reason: "invoice_portal_entrypoint" },
      { pattern: /factura express/, reason: "express_invoice_entrypoint" },
      { pattern: /facturacion express/, reason: "express_invoice_entrypoint" },
      { pattern: /factura aqui/, reason: "invoice_entrypoint" },
      { pattern: /facturar aqui/, reason: "invoice_entrypoint" },
      { pattern: /genera tu factura/, reason: "invoice_entrypoint" },
      { pattern: /generar tu factura/, reason: "invoice_entrypoint" },
      { pattern: /facturacion electronica/, reason: "invoice_entrypoint" },
      { pattern: /portal de facturacion/, reason: "invoice_portal_entrypoint" },
      { pattern: /ticket de compra/, reason: "ticket_entrypoint" },
    ];
    const controls = [...document.querySelectorAll("a, button, input[type='button'], input[type='submit'], [role='button']")]
      .filter((element) => visible(element) && !disabled(element))
      .map((element) => ({
        element,
        rawText: textFor(element).replace(/\s+/g, " ").trim(),
        text: normalize(textFor(element)),
      }));

    for (const target of transitionTargets) {
      const match = controls.find((control) => target.pattern.test(control.text));
      if (match) {
        const urlBefore = window.location.href;
        match.element.click();
        return {
          text: match.rawText.slice(0, 180),
          urlBefore,
          reason: target.reason,
        };
      }
    }

    return null;
  });
}

async function executeStagehandFinalSubmitAndDownloads({ stagehand, page, context, trace }) {
  const canCaptureDownloads = typeof page.waitForEvent === "function";
  const downloadPromises = canCaptureDownloads
    ? [
        page.waitForEvent("download", { timeout: 45000 }).catch(() => null),
        page.waitForEvent("download", { timeout: 45000 }).catch(() => null),
      ]
    : [];
  const actResult = await runStagehandActWithTimeout(
    stagehand,
    "Click the final button to generate the CFDI invoice, then download both XML and PDF files. Do not change fiscal regime or CFDI use.",
    {
      page,
      timeout: Math.max(getStagehandActTimeoutMs(), 90000),
      serverCache: false,
    },
  );
  trace.stagehandActs.push({
    instruction: "finalSubmitAndDownload",
    success: actResult?.success ?? null,
    message: actResult?.message ?? null,
    actionDescription: actResult?.actionDescription ?? null,
    cacheStatus: actResult?.cacheStatus ?? null,
    actionCount: actResult?.actions?.length ?? 0,
  });
  trace.executedActions.push(...convertStagehandActionsToTrace(actResult?.actions, "finalSubmitAndDownload"));

  if (!canCaptureDownloads) {
    const artifacts = await captureStagehandArtifacts(page, {
      context,
      prefix: `${context.id ?? "job"}-stagehand-final`,
    }).catch(() => null);

    return {
      status: "needs_user_action",
      reason: "stagehand_download_capture_unsupported",
      statusMessage: "Stagehand ejecuto el paso final, pero esta pagina V3 no expone eventos de descarga al lab",
      artifacts,
    };
  }

  const downloads = (await Promise.all(downloadPromises)).filter(Boolean);
  const saved = await saveDownloads(downloads, context);
  const artifacts = await captureStagehandArtifacts(page, {
    context,
    prefix: `${context.id ?? "job"}-stagehand-final`,
  }).catch(() => null);

  return {
    ...saved,
    status: saved.xmlPath && saved.pdfPath ? "completed" : "needs_user_action",
    reason: saved.xmlPath && saved.pdfPath ? "stagehand_downloaded_cfdi" : "stagehand_download_incomplete",
    statusMessage:
      saved.xmlPath && saved.pdfPath
        ? "CFDI descargado por Stagehand"
        : "Stagehand emitio o intento emitir, pero no capturo XML/PDF completos",
    artifacts,
  };
}

async function saveDownloads(downloads, context) {
  const { mkdir } = await import("node:fs/promises");
  const { isAbsolute, join, resolve } = await import("node:path");
  const { getPortalArtifactsDir } = await import("../config/env.mjs");
  const directory = getPortalArtifactsDir();
  const outputDir = resolve(directory);
  const result = {
    downloadMode: "stagehand",
    downloadErrors: [],
  };

  await mkdir(outputDir, { recursive: true });

  for (const [index, download] of downloads.entries()) {
    const suggested = download.suggestedFilename?.() ?? `cfdi-${index + 1}`;
    const kind = suggested.toLowerCase().includes(".xml") ? "xml" : suggested.toLowerCase().includes(".pdf") ? "pdf" : `file${index + 1}`;
    const fileName = `${safeFilePart(context.id ?? "job")}-${Date.now()}-${safeFilePart(suggested)}`;
    const outputPath = resolve(outputDir, fileName);

    await download.saveAs(outputPath);
    const displayPath = (isAbsolute(directory) ? resolve(directory, fileName) : join(directory, fileName)).replaceAll(
      "\\",
      "/",
    );
    result[`${kind}Path`] = displayPath;
    result[`${kind}DownloadFileName`] = suggested;
    result[`${kind}Url`] = typeof download.url === "function" ? download.url() : null;
  }

  return result;
}

function buildStagehandInstructionPlan(context, job) {
  const finalSubmitAllowed = buildStagehandLabFinalGuard(job).ready;
  const fiscalUse = context.cfdiUseCode || context.cfdiUse || "S01";
  const fiscalRegime = context.fiscalRegimeCode || context.fiscalRegime || "";
  const ticketIdentifiers = context.ticketIdentifiers || "no extra ticket identifiers";
  const invoiceCode = context.codigoFacturacion || context.ticketId || context.folio;
  const instructions = [
    `Close or accept only safe informational modals, cookie banners, or alerts. If there is a blocking login-only path, look for express/public invoicing alternatives first. Do not solve CAPTCHA.`,
    `Navigate to the ticket invoicing form. If the page is only an informational landing, click entrypoint labels such as Ir al Portal de Facturación, Factura aquí, Facturación electrónica, Portal de facturación, Ticket de compra, or Genera tu factura until ticket input fields are visible. If a login page offers Factura Express, choose Factura Express instead of login/registro.`,
    `Fill every visible ticket lookup field, matching labels flexibly. Known values: RFC emisor ${context.rfcEmisor}, receiver RFC ${context.rfcReceptor}, postal code ${context.postalCode}, folio/TC/ticket ${context.folio}, codigoFacturacion/ticketId ${invoiceCode}, fecha ${context.fecha}, total ${context.monto}, ${ticketIdentifiers}. If the portal asks for Membresia o RFC use receiver RFC ${context.rfcReceptor}. If it asks for Codigo postal use ${context.postalCode}. If a field says Codigo de facturacion, Codigo Fact, Codigo unico, No. Ticket, Numero de ticket, ticket id, or shows a hint that the ticket has 30+ digits, use codigoFacturacion/ticketId ${invoiceCode}, not the short folio ${context.folio}. If it clearly asks for folio, venta, operation, or ticket short number use ${context.folio}. If it asks for # Transaccion, TR, transaction, or transaccion use ${context.ocrCandidates?.tr ?? context.ocrCandidates?.TR ?? ""}. Then click only safe search/validate/continue buttons.`,
    `If another ticket or payment validation step appears, fill it from the known ticket values (${ticketIdentifiers}) AND click the 'Agregar', 'Buscar', 'Siguiente' or 'Validar' button to load the ticket data. Do not click final Facturar/Generar/Emitir buttons.`,
    `Fill or confirm fiscal receiver data exactly from the user's tax profile: RFC ${context.rfcReceptor}, legal name ${context.legalName}, postal code ${context.postalCode}, email ${context.email}. Select fiscal regime ${fiscalRegime} and CFDI use ${fiscalUse}. Do not choose a different regime or CFDI use if unavailable; stop and leave evidence instead.`,
  ];

  if (finalSubmitAllowed) {
    instructions.push(
      "If the page now shows a final generate/facturar button and all fiscal data is valid, leave it ready for final submission. Do not download yet; downloads will be handled in the final guarded step.",
    );
  } else {
    instructions.push(
      "Stop when the final generate/facturar button is visible or enabled. Do not click any final submit/generate/facturar button.",
    );
  }

  return instructions;
}

async function inspectStagehandFinalReadiness(page) {
  return page
    .evaluate(() => {
      const finalText = /facturar|generar\s+factura|emitir|timbrar|finalizar/i;
      const controls = [...document.querySelectorAll("button, input[type='submit'], input[type='button'], a")]
        .map((element) => {
          const id = element.getAttribute("id") ?? "";
          const name = element.getAttribute("name") ?? "";
          const className = element.getAttribute("class") ?? "";
          const text = [
            element.innerText,
            element.textContent,
            element.value,
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
          ]
            .filter(Boolean)
            .join(" ");
          const box = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          const visible =
            box.width > 0 &&
            box.height > 0 &&
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            style.opacity !== "0";
          const disabled =
            element.disabled === true ||
            element.getAttribute("disabled") !== null ||
            element.getAttribute("aria-disabled") === "true";

          return {
            text: text.replace(/\s+/g, " ").trim(),
            visible,
            enabled: visible && !disabled,
            looksFinal: finalText.test(text),
            isNavigationTab:
              /radFacturar/i.test(`${id} ${name}`) ||
              /tab|nav/i.test(className) ||
              /^facturar$/i.test(String(element.value ?? "").trim()),
          };
        })
        .filter((control) => control.looksFinal && !control.isNavigationTab);

      return {
        ready: controls.some((control) => control.enabled),
        reason: controls.some((control) => control.enabled)
          ? "final_visible_enabled"
          : controls.some((control) => control.visible)
            ? "final_visible_disabled"
            : "final_not_visible",
        controls: controls.slice(0, 10),
      };
    })
    .catch((error) => ({
      ready: false,
      reason: "final_readiness_inspection_failed",
      error: error.message,
    }));
}

function buildLearnedActions({ context, observedActions, executedActions, includeFinalSubmit }) {
  const converted = [
    {
      type: "goto",
      url: context.portalUrl,
      reason: "open_portal",
    },
    ...buildKnownPortalSeedActions(context, includeFinalSubmit),
    ...convertObservedActionsToCache(observedActions),
    ...convertExecutedActionsToCache(executedActions),
  ];
  const deduped = [];
  const seen = new Set();

  for (const action of converted) {
    const key = `${action.type}:${action.selector ?? action.text ?? action.instruction ?? action.url ?? ""}:${action.valueFrom ?? action.value ?? ""}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(action);
  }

  return deduped;
}

function buildKnownPortalSeedActions(context, includeFinalSubmit) {
  const host = getHost(context.portalUrl);

  if (!host.includes("facturacionpintu") && !host.includes("pinturerias")) {
    return [];
  }

  return [
    {
      type: "fill",
      selector: 'input[placeholder*="RFC con el cual desea facturar"]',
      valueFrom: "rfcReceptor",
      reason: "pinturerias_receiver_rfc",
    },
    {
      type: "fill",
      selector: 'input[placeholder="Num. Sucursal"]',
      valueFrom: "sucursal",
      reason: "pinturerias_branch",
    },
    {
      type: "click",
      selector: 'button.btn-outline-secondary:has-text("Buscar")',
      waitMs: 2500,
      reason: "pinturerias_validate_branch",
    },
    {
      type: "clickFirstVisible",
      selector: 'button.mat-stepper-next:has-text("Siguiente")',
      timeoutMs: 30000,
      waitMs: 1200,
      reason: "pinturerias_continue_after_customer_lookup",
    },
    {
      type: "fill",
      selector: "#numVenta",
      valueFrom: "folio",
      reason: "pinturerias_ticket",
    },
    {
      type: "fill",
      selector: "#serie",
      valueFrom: "serie",
      reason: "pinturerias_series",
    },
    {
      type: "fill",
      selector: "#token",
      valueFrom: "token",
      reason: "pinturerias_token",
    },
    {
      type: "click",
      selector: 'mat-horizontal-stepper button[type="submit"].mat-mdc-raised-button:has-text("Buscar")',
      waitMs: 2500,
      reason: "pinturerias_validate_ticket",
    },
    {
      type: "waitForSelector",
      selector: "#regimenFiscal",
      timeoutMs: 15000,
      reason: "pinturerias_wait_fiscal_controls",
    },
    {
      type: "select",
      selector: "#regimenFiscal",
      valueFrom: "fiscalRegime",
      reason: "pinturerias_fiscal_regime",
    },
    {
      type: "select",
      selector: "#cfdi",
      valueFrom: "cfdiUse",
      reason: "pinturerias_cfdi_use",
    },
    {
      type: "fillFirstVisible",
      selector: '#correo, input[name="correo"], input[placeholder="Correo"]',
      valueFrom: "email",
      waitMs: 800,
      reason: "pinturerias_email",
    },
    {
      type: "clickFirstVisible",
      selector: 'button:has-text("Guardar Correo")',
      timeoutMs: 15000,
      waitMs: 2500,
      reason: "pinturerias_save_email",
    },
    {
      type: "waitForEnabled",
      selector: 'button:has-text("Facturar")',
      timeoutMs: 15000,
      reason: "pinturerias_wait_final_submit_ready",
    },
    ...(includeFinalSubmit
      ? [
          {
            type: "finalSubmit",
            selector: 'button:has-text("Facturar")',
            allowSubmit: true,
            waitMs: 2000,
            reason: "pinturerias_final_submit",
          },
          {
            type: "download",
            xmlSelector: 'a:has-text("XML"), button:has-text("XML")',
            pdfSelector: 'a:has-text("PDF"), button:has-text("PDF")',
            reason: "pinturerias_download_cfdi",
          },
        ]
      : []),
  ];
}

function convertObservedActionsToCache(actions) {
  return (actions ?? []).flatMap((action) => convertStagehandActionToCache(action, "observed"));
}

function convertExecutedActionsToCache(actions) {
  return (actions ?? []).flatMap((action) => convertStagehandActionToCache(action, "executed"));
}

function convertStagehandActionToCache(action, source) {
  if (!action?.selector) {
    return [];
  }

  const method = String(action.method ?? "").toLowerCase();

  if (method.includes("click")) {
    return [
      {
        type: "click",
        selector: action.selector,
        reason: `${source}_stagehand_click`,
      },
    ];
  }

  if (method.includes("fill") || method.includes("type")) {
    return [
      {
        type: "fill",
        selector: action.selector,
        value: firstArgument(action.arguments),
        reason: `${source}_stagehand_fill`,
      },
    ];
  }

  if (method.includes("select")) {
    return [
      {
        type: "select",
        selector: action.selector,
        value: firstArgument(action.arguments),
        reason: `${source}_stagehand_select`,
      },
    ];
  }

  return [];
}

function convertStagehandActionsToTrace(actions, instruction) {
  return (actions ?? []).map((action) => ({
    instruction,
    selector: action.selector ?? null,
    description: action.description ?? null,
    method: action.method ?? null,
    arguments: action.arguments ?? [],
  }));
}

function buildObservePrompt(context) {
  return [
    "Observe the page controls needed for Mexican CFDI invoice generation.",
    `Ticket values: RFC emisor ${context.rfcEmisor}, folio ${context.folio}, fecha ${context.fecha}, total ${context.monto}, ${context.ticketIdentifiers || "no extra identifiers"}.`,
    `Receiver fiscal data: RFC ${context.rfcReceptor}, regime ${context.fiscalRegime}, CFDI use ${context.cfdiUse}, postal code ${context.postalCode}.`,
    "Return useful actions/selectors for ticket validation, fiscal fields, final invoice button, and XML/PDF download links.",
  ].join(" ");
}

function buildStagehandContext({ job, extracted, taxProfile, fiscalCompliance, portalUrl }) {
  return {
    id: job?.id ?? "stagehand_lab_job",
    portalUrl,
    rfcEmisor: extracted?.rfcEmisor ?? job?.rfcEmisor,
    rfcReceptor: job?.rfcReceptor ?? taxProfile?.rfc,
    folio: extracted?.folio ?? extracted?.ocrCandidates?.folioTicket ?? extracted?.ocrCandidates?.ticketId,
    codigoFacturacion:
      extracted?.ocrCandidates?.codigoFacturacion ??
      extracted?.ocrCandidates?.codigoFact ??
      extracted?.ocrCandidates?.codigoUnico ??
      extracted?.ocrCandidates?.ticketId,
    ticketId: extracted?.ocrCandidates?.ticketId,
    fecha: extracted?.fecha ?? extracted?.ocrCandidates?.fecha,
    monto: extracted?.monto ?? extracted?.ocrCandidates?.monto,
    sucursal: extracted?.ocrCandidates?.sucursal ?? job?.manualOverrides?.ocrCandidates?.sucursal,
    serie: extracted?.ocrCandidates?.serie ?? job?.manualOverrides?.ocrCandidates?.serie,
    token: extracted?.ocrCandidates?.token ?? job?.manualOverrides?.ocrCandidates?.token,
    legalName: taxProfile?.legalName,
    email: taxProfile?.email,
    postalCode: taxProfile?.postalCode,
    fiscalRegime:
      fiscalCompliance?.fiscalRegimeCodes?.[0] ??
      fiscalCompliance?.fiscalRegimes?.[0] ??
      taxProfile?.fiscalRegime ??
      taxProfile?.fiscalRegimes?.[0],
    fiscalRegimeCode:
      fiscalCompliance?.fiscalRegimeCodes?.[0] ?? String(taxProfile?.fiscalRegime ?? "").match(/^[0-9]{3}/)?.[0] ?? null,
    cfdiUse: fiscalCompliance?.expectedCfdiUse?.code ?? taxProfile?.cfdiUse,
    cfdiUseCode: fiscalCompliance?.expectedCfdiUse?.code ?? String(taxProfile?.cfdiUse ?? "").match(/^[A-Z0-9]{3}/)?.[0] ?? null,
    ocrCandidates: extracted?.ocrCandidates ?? {},
    ticketIdentifiers: describeTicketIdentifiers(extracted?.ocrCandidates ?? {}),
    ocrTextPreview: extracted?.ocrTextPreview ?? extracted?.ocrText?.slice?.(0, 1200) ?? null,
    taxProfile,
    fiscalCompliance,
  };
}

function describeTicketIdentifiers(candidates = {}) {
  const entries = Object.entries(candidates)
    .filter(([, value]) => {
      if (value === null || value === undefined || value === "") return false;
      if (Array.isArray(value)) return value.length > 0 && value.length <= 5;
      return typeof value !== "object";
    })
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`);

  return entries.join("; ");
}

function buildStagehandLabFinalGuard(job) {
  const checks = {
    workerAllowsFinalSubmit: process.env.STAGEHAND_ALLOW_FINAL_SUBMIT === "true",
    jobApprovedFinalSubmit: job?.portalFinalSubmitApproved === true,
  };
  const blockedBy = [];

  if (!checks.workerAllowsFinalSubmit) blockedBy.push("stagehand_worker_allow_submit_false");
  if (!checks.jobApprovedFinalSubmit) blockedBy.push("job_final_submit_not_approved");

  return {
    ready: blockedBy.length === 0,
    blockedBy,
    ...checks,
  };
}

function resolvePortalUrl({ job, extracted, portalUrl, template }) {
  return (
    firstString(portalUrl) ??
    firstString(job?.aiPortalUrl) ??
    firstString(job?.portalCandidateUrl) ??
    firstString(job?.portalUrl) ??
    firstString(extracted?.portalUrl) ??
    firstString(template?.portalUrl) ??
    firstString(job?.portalCandidates?.[0]?.url) ??
    firstString(extracted?.portalDiscovery?.bestCandidate?.url) ??
    firstString(extracted?.portalDiscovery?.portalCandidates?.[0]?.url)
  );
}

function classifyStagehandBlockReason(error) {
  const text = String(error?.message ?? error ?? "").toLowerCase();

  if (text.includes("captcha")) return "captcha_detected";
  if (text.includes("login") || text.includes("iniciar sesion") || text.includes("sign in")) return "login_required";
  if (text.includes("vencid") || text.includes("expired")) return "ticket_expired";
  if (text.includes("regimen") || text.includes("régimen") || text.includes("cfdi")) return "fiscal_rule_blocked";
  return null;
}

function normalizeStagehandEnv(value) {
  return value === "BROWSERBASE" ? "BROWSERBASE" : "LOCAL";
}

function buildBrowserbaseStagehandOptions(stagehandEnv, context) {
  if (stagehandEnv !== "BROWSERBASE") {
    return {};
  }

  return {
    apiKey: getBrowserbaseApiKey(),
    projectId: getBrowserbaseProjectId(),
    browserbaseSessionCreateParams: {
      projectId: getBrowserbaseProjectId(),
      region: normalizeBrowserbaseRegion(getBrowserbaseRegion()),
      proxies: shouldUseBrowserbaseProxies(),
      timeout: Number(process.env.BROWSERBASE_SESSION_TIMEOUT_SECONDS ?? 3600),
      browserSettings: {
        viewport: { width: 1365, height: 900 },
        solveCaptchas: shouldUseBrowserbaseCaptchaSolving(),
        advancedStealth: shouldUseBrowserbaseAdvancedStealth(),
        recordSession: shouldRecordBrowserbaseSession(),
        blockAds: true,
      },
      userMetadata: {
        app: "easysat-billing-service",
        jobId: safeBrowserbaseMetadataValue(context?.id ?? "stagehand_lab_job"),
        rfcEmisor: safeBrowserbaseMetadataValue(context?.rfcEmisor ?? "unknown"),
        portalHost: safeBrowserbaseMetadataValue(getHost(context?.portalUrl) || "unknown"),
      },
    },
  };
}

function safeBrowserbaseMetadataValue(value) {
  return String(value ?? "unknown")
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "unknown";
}

function normalizeBrowserbaseRegion(value) {
  return ["us-west-2", "us-east-1", "eu-central-1", "ap-southeast-1"].includes(value)
    ? value
    : "us-west-2";
}

function normalizeStagehandModel(value) {
  const model = String(value ?? "").trim();

  if (model === "google/gemini-3.1-flash-lite") {
    return "google/gemini-3.1-flash-lite";
  }

  return model || "google/gemini-3.1-flash-lite";
}

function safePageUrl(page, fallback = null) {
  try {
    return typeof page?.url === "function" ? page.url() : fallback;
  } catch {
    return fallback;
  }
}

function firstArgument(args) {
  return Array.isArray(args) && args.length ? args[0] : undefined;
}

function firstString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getHost(url) {
  try {
    return new URL(String(url ?? "")).host.toLowerCase();
  } catch {
    return "";
  }
}

function safeFilePart(value) {
  return String(value ?? "unknown")
    .replace(/[^a-z0-9_.-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

export function getStagehandRegistryPathForContext({ rfcEmisor, portalUrl }) {
  return getStagehandStatePathForDisplay({ rfcEmisor, portalUrl });
}
