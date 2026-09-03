import { getEnv } from "../config/env.mjs";
import { findPortalTemplateById } from "../portals/portal-registry.mjs";
import { runWithPortalRateLimit } from "../portals/portal-rate-limiter.mjs";
import { buildFlutterWebviewHandoff } from "./flutter-webview-handoff.mjs";
import { runInteractiveCheckpoint } from "./interactive-checkpoint-runner.mjs";

export async function runCapaCInteractiveResume(job, hooks = {}) {
  const checkpoint = job?.userAction?.checkpoint;
  const reason = job?.userAction?.reason ?? job?.reason ?? "manual_portal_required";

  if (!checkpoint?.portalUrl && !checkpoint?.currentUrl) {
    return buildNeedsActionResult({
      job,
      reason,
      statusMessage: "No hay URL de portal para preparar una sesion asistida.",
      interactiveSession: {
        status: "unavailable",
        reason: "checkpoint_url_missing",
      },
    });
  }

  await hooks.onEvent?.({
    type: "capa_c_resume_started",
    status: "capa_c_preparing",
    message: "Preparando portal asistido para Capa C",
    actor: "worker",
    metadata: {
      reason,
      portalUrl: checkpoint.currentUrl ?? checkpoint.portalUrl,
      templateId: checkpoint.templateId ?? job?.portalTemplateId ?? null,
    },
  });

  const template = await findPortalTemplateById(checkpoint.templateId ?? job?.portalTemplateId).catch(() => null);
  const fixture = buildFixtureFromJob(job, checkpoint);
  const handoffMode = getEnv("CAPA_C_HANDOFF_MODE", "local_browser");

  if (handoffMode === "flutter_webview") {
    const mobileHandoff = buildFlutterWebviewHandoff({
      reason,
      checkpoint,
      template,
      taxProfile: job?.taxProfile ?? {},
      editableFields: job?.userAction?.editableFields ?? [],
      portalMessage: job?.userAction?.portalMessage ?? null,
    });
    const interactiveSession = {
      status: mobileHandoff ? "ready" : "unavailable",
      reason: mobileHandoff ? "flutter_webview_handoff_ready" : "checkpoint_url_missing",
      statusMessage: mobileHandoff
        ? "Handoff listo para abrir WebView en Flutter."
        : "No hay URL de portal para abrir WebView.",
      currentUrl: mobileHandoff?.initialUrl ?? null,
      browserKeptOpen: false,
      mode: "flutter_webview",
      templateId: template?.id ?? null,
      updatedAt: new Date().toISOString(),
    };

    await hooks.onEvent?.({
      type: mobileHandoff ? "capa_c_mobile_handoff_ready" : "capa_c_mobile_handoff_failed",
      status: "needs_user_action",
      message: interactiveSession.statusMessage,
      actor: "worker",
      metadata: {
        reason,
        currentUrl: interactiveSession.currentUrl,
        templateId: template?.id ?? null,
      },
    });

    return buildNeedsActionResult({
      job,
      reason,
      statusMessage: interactiveSession.statusMessage,
      interactiveSession,
      mobileHandoff,
    });
  }

  const headless = getEnv("CAPA_C_HEADLESS", "false") === "true";
  const keepBrowserOpen = getEnv("CAPA_C_KEEP_BROWSER_OPEN", "true") !== "false";
  const useFixture =
    checkpoint.useFixture === true ||
    job?.source === "capa_c_demo" ||
    getEnv("CAPA_C_USE_FIXTURE", "false") === "true";

  await hooks.assertClaimActive?.();
  const rateLimitTarget = template ?? {
    portalUrl: checkpoint.currentUrl ?? checkpoint.portalUrl,
    rfcEmisor: fixture.rfcEmisor,
    rateLimit: { concurrency: 1, perMinute: 6 },
  };
  const result = await runWithPortalRateLimit(
    rateLimitTarget,
    () => runInteractiveCheckpoint({
      checkpoint,
      template,
      fixture,
      taxProfile: job?.taxProfile ?? {},
      approveFinalSubmit: true,
      headless,
      autoSubmitAfterUser: false,
      waitForUser: false,
      keepBrowserOpen,
      useFixture,
      runId: job?.id ?? "capa_c_resume",
    }),
    { signal: hooks.signal },
  );

  const ready = result.ok === true;
  const interactiveSession = {
    status: ready ? "ready" : "failed",
    reason: result.reason ?? null,
    statusMessage: result.statusMessage ?? null,
    currentUrl: result.currentUrl ?? null,
    runDir: result.runDir ?? null,
    downloadsDir: result.downloadsDir ?? null,
    browserKeptOpen: ready && keepBrowserOpen && !headless,
    useFixture,
    templateId: template?.id ?? null,
    executedSteps: result.executedSteps ?? [],
    stoppedAt: result.stoppedAt ?? null,
    artifacts: result.artifacts ?? null,
    error: result.ok === false ? result.statusMessage ?? null : null,
    updatedAt: new Date().toISOString(),
  };

  await hooks.onEvent?.({
    type: ready ? "capa_c_resume_ready" : "capa_c_resume_failed",
    status: "needs_user_action",
    message: ready
      ? "Portal asistido listo para intervencion manual"
      : "No se pudo preparar el portal asistido",
    actor: "worker",
    metadata: {
      reason,
      currentUrl: interactiveSession.currentUrl,
      runDir: interactiveSession.runDir,
      browserKeptOpen: interactiveSession.browserKeptOpen,
    },
  });

  return buildNeedsActionResult({
    job,
    reason,
    statusMessage: ready
      ? "Portal asistido listo. Usa la ventana del navegador abierta para continuar."
      : result.statusMessage ?? "No se pudo preparar el portal asistido.",
    interactiveSession,
    mobileHandoff: buildFlutterWebviewHandoff({
      reason,
      checkpoint,
      template,
      taxProfile: job?.taxProfile ?? {},
      editableFields: job?.userAction?.editableFields ?? [],
      portalMessage: job?.userAction?.portalMessage ?? null,
    }),
  });
}

function buildNeedsActionResult({ job, reason, statusMessage, interactiveSession, mobileHandoff = null }) {
  const userAction = {
    ...(job?.userAction ?? {}),
    status: "user_action_required",
    reason,
    expectedNextStep: "resume_interactive_checkpoint",
    title: job?.userAction?.title ?? titleForReason(reason),
    message: statusMessage,
    interactiveSession,
    mobileHandoff: mobileHandoff ?? job?.userAction?.mobileHandoff ?? null,
  };

  return {
    status: "needs_user_action",
    reason,
    statusMessage,
    userAction,
    interactiveSession,
    mobileHandoff: mobileHandoff ?? job?.mobileHandoff ?? null,
    error: null,
    lastError: null,
    claimedBy: null,
    leaseExpiresAt: null,
    retryAt: null,
  };
}

function buildFixtureFromJob(job = {}, checkpoint = {}) {
  const ticketData = checkpoint.ticketData ?? {};
  return {
    id: job.id,
    uid: job.uid,
    rfcEmisor: checkpoint.rfcEmisor ?? job.rfcEmisor ?? job.extractedData?.rfcEmisor ?? null,
    rfcReceptor: job.rfcReceptor ?? job.taxProfile?.rfc ?? null,
    folio: ticketData.folio ?? job.folio ?? null,
    ticketId: ticketData.ticketId ?? job.ocrCandidates?.ticketId ?? null,
    fecha: ticketData.fecha ?? job.fecha ?? null,
    monto: ticketData.monto ?? job.monto ?? null,
    permisoCre: ticketData.permisoCre ?? job.permisoCre ?? null,
    codigoFacturacion: ticketData.codigoFacturacion ?? job.codigoFacturacion ?? null,
    estacionCodigo: ticketData.estacionCodigo ?? job.ocrCandidates?.estacionCodigo ?? null,
    estacionNombre: ticketData.estacionNombre ?? job.ocrCandidates?.estacionNombre ?? null,
    sucursal: ticketData.sucursal ?? job.ocrCandidates?.sucursal ?? null,
    serie: ticketData.serie ?? job.ocrCandidates?.serie ?? null,
    token: ticketData.token ?? job.ocrCandidates?.token ?? null,
    terminal: ticketData.terminal ?? job.ocrCandidates?.terminal ?? null,
    webId: ticketData.webId ?? job.ocrCandidates?.webId ?? null,
    portalUrl: checkpoint.portalUrl ?? job.portalUrl ?? job.portalCandidateUrl ?? null,
    portalCandidateUrl: job.portalCandidateUrl ?? checkpoint.portalUrl ?? null,
    ocrCandidates: {
      ...(job.ocrCandidates ?? {}),
      ...ticketData,
    },
    taxProfile: job.taxProfile ?? {},
  };
}

function titleForReason(reason) {
  switch (reason) {
    case "captcha_required":
      return "CAPTCHA requerido";
    case "login_required":
      return "Login requerido";
    case "portal_blocked":
      return "Portal bloqueado";
    default:
      return "Intervencion requerida";
  }
}
