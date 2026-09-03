import { extractTicketData } from "../ocr/ocr.service.mjs";
import { enrichTicketExtraction } from "../ocr/ticket-enrichment.service.mjs";
import {
  isAutonomousBillingJob,
  isAutonomousOcrAccepted,
  resolveAutonomousOcr,
} from "../ocr/autonomous-ocr.service.mjs";
import { shouldTryAiNavigationForSafeStop } from "../ai-navigation/ai-navigation.service.mjs";
import {
  b3ResultHasCfdi,
  b3ResultHasFiscalXml,
  canRunB3BrowserUse,
  runB3BrowserUseFallback,
} from "../b3-browseruse/b3-orchestrator-runner.mjs";
import { runWithPortalRateLimit } from "../portals/portal-rate-limiter.mjs";
import { findPortalTemplateByRfc } from "../portals/portal-registry.mjs";
import { findRememberedManualOutcome, rememberPortalOutcome } from "../portals/portal-outcome-memory.mjs";
import { findPortalCandidatesByRfc } from "../portals/portal-url-directory.mjs";
import { resolveTemplateFields } from "../portals/template-fields.mjs";
import { evaluateTemplatePreflight } from "../portals/template-preflight.mjs";
import { runPortalTemplate } from "../portals/template-runner.mjs";
import { degradeTemplateCandidate } from "../portals/template-candidates.mjs";
import {
  recoverOxxoCfdiByReprint,
  shouldRecoverOxxoWithReprint,
} from "../portals/recovery/oxxo-reprint-recovery.mjs";
import { materializeAvailableCfdiResult, materializeCfdiResult } from "../storage/cfdi-storage.service.mjs";
import { materializePortalArtifacts } from "../storage/portal-artifact-storage.service.mjs";
import { isPortalDiscoveryEnabled, shouldForceAiNavigation } from "../config/env.mjs";
import { buildB3UsageTelemetry } from "../monitoring/b3-usage-telemetry.mjs";
import { logger } from "../shared/logger.mjs";
import { buildOcrCheckpoint, readReusableOcrCheckpoint } from "./ocr-checkpoint.mjs";
import {
  buildFiscalComplianceContext,
  isFiscalComplianceBlocking,
} from "../fiscal/fiscal-compliance.service.mjs";
import {
  applyPortalDiscoveryToExtraction,
  discoverPortalFromTicket,
} from "../portal-discovery/portal-discovery.service.mjs";
import { buildFallbackResult } from "./fallback-policy.mjs";
import {
  ROUTER_DECISIONS,
  decideB3Route,
  decideRememberedOutcomeRoute,
  shouldStopB3Retries,
} from "./layer-router-policy.mjs";
import {
  applyAutopilotApprovalToContext,
  applySelectedVariantToExtractionPatch,
  buildAutopilotDecision,
  buildMandatoryOcrConfirmation,
  buildOcrFieldReview,
  buildPortalAttemptContexts,
  shouldRetryPortalAttempt,
} from "./autopilot-policy.mjs";
import {
  buildResolvedAlreadyInvoicedResult,
  buildUserActionRequiredResult,
  isAlreadyInvoicedReason,
} from "./user-action-policy.mjs";

export async function runBillingOrchestrator(job, hooks = {}) {
  const result = await _runBillingOrchestratorInternal(job, hooks);
  if (!result) return result;

  // Post-process to ensure portalName and businessDomain are populated if possible
  const rfcEmisor = result.rfcEmisor ?? job.rfcEmisor ?? result.extracted?.rfcEmisor ?? result.rememberedManualOutcome?.rfcEmisor;
  const portalUrl = result.portalUrl ?? job.portalUrl ?? result.currentUrl ?? result.rememberedManualOutcome?.portalUrl;
  const ocrCandidates = result.ocrCandidates ?? job.ocrCandidates;

  const hasCompiledName = typeof result.portalName === "string" && result.portalName.toLowerCase().startsWith("compiled gpt");
  if (!result.portalName || !result.businessDomain || hasCompiledName) {
    const inferred = inferPortalDetails({ rfcEmisor, portalUrl, ocrCandidates });
    if (inferred) {
      if ((!result.portalName || hasCompiledName) && inferred.portalName) {
        result.portalName = inferred.portalName;
      }
      if ((!result.businessDomain || hasCompiledName) && inferred.businessDomain) {
        result.businessDomain = inferred.businessDomain;
      }
    }
  }

  return result;
}

async function _runBillingOrchestratorInternal(job, hooks = {}) {
  const emit = hooks.onEvent ?? (() => {});
  const cachedExtraction = readReusableOcrCheckpoint(job);
  let extracted;

  if (cachedExtraction) {
    extracted = applyManualOverrides(cachedExtraction, job.manualOverrides);
    await emit({
      type: "ocr_checkpoint_reused",
      status: "portal_processing",
      message: "Datos del ticket confirmados; iniciando facturacion",
      actor: "worker",
      metadata: {
        checkpointVersion: job.ocrCheckpoint?.version ?? "legacy_extracted_data",
        ocrEngine: extracted.ocrEngine ?? null,
        rfcEmisor: extracted.rfcEmisor ?? null,
      },
    });
  } else {
    await emit({
      type: "ocr_started",
      status: "ocr_processing",
      message: "OCR iniciado",
      actor: "worker",
    });
    const rawExtracted = await extractTicketData(job.ticketFileUrl, { uid: job.uid });
    extracted = applyManualOverrides(rawExtracted, job.manualOverrides);
    await emit({
      type: "ocr_completed",
      status: "ocr_processing",
      message: "OCR completo",
      actor: "worker",
      metadata: {
        ocrEngine: extracted.ocrEngine ?? "mock",
        rfcEmisor: extracted.rfcEmisor ?? null,
        folio: extracted.folio ?? null,
        fecha: extracted.fecha ?? null,
        monto: extracted.monto ?? null,
      },
    });

    const portalDiscovery = await runPortalDiscoveryIfEnabled({
      emit,
      job,
      extracted,
      probeUrls: hooks.allowPortalProbe !== false,
    });
    extracted = applyPortalDiscoveryToExtraction(extracted, portalDiscovery);
  }

  extracted = enrichTicketExtraction(extracted);
  await emit({
    type: "ticket_enrichment_completed",
    status: "ocr_processing",
    message: "Enriquecimiento de ticket completado",
    actor: "worker",
    metadata: {
      businessDomain: extracted.businessDomain ?? null,
      permisoCre: extracted.permisoCre ?? null,
      permisoCreNeedsReview: extracted.ticketEnrichment?.permisoCre?.needsReview ?? false,
      fuelDetected: extracted.ticketEnrichment?.fuel?.isFuel ?? false,
    },
  });

  if (isAutonomousBillingJob(job) && !cachedExtraction) {
    const autonomousOcr = await resolveAutonomousOcr({ job, extracted });
    extracted = autonomousOcr.extracted;
    await emit({
      type: "ocr_autonomous_resolved",
      status: "ocr_processing",
      message: autonomousOcr.resolution.status === "accepted"
        ? "Datos del ticket resueltos automaticamente"
        : "No fue posible resolver todos los datos del ticket",
      actor: "worker",
      metadata: {
        resolutionStatus: autonomousOcr.resolution.status,
        confidence: autonomousOcr.resolution.confidence,
        unresolvedFields: autonomousOcr.resolution.unresolvedFields,
        candidateSetCount: autonomousOcr.resolution.candidateSets.length,
        evidenceGate: autonomousOcr.resolution.evidenceGate,
        providers: autonomousOcr.resolution.providers,
      },
    });
  }
  let extractionPatch = buildExtractionPatch(extracted, job);

  const portalCandidatePatch = await buildPortalCandidatePatch(job, extracted);
  let jobWithPortalCandidates = {
    ...job,
    ...portalCandidatePatch,
  };
  const fiscalCompliance = buildFiscalComplianceContext(jobWithPortalCandidates.taxProfile);
  extractionPatch = {
    ...extractionPatch,
    fiscalCompliance,
  };
  jobWithPortalCandidates = {
    ...jobWithPortalCandidates,
    fiscalCompliance,
  };

  await emit({
    type: "fiscal_compliance_checked",
    status: isFiscalComplianceBlocking(fiscalCompliance) ? "needs_user_action" : "ocr_processing",
    message: fiscalCompliance.statusMessage,
    actor: "worker",
    metadata: {
      reason: fiscalCompliance.reason,
      personType: fiscalCompliance.personType,
      fiscalRegimeCodes: fiscalCompliance.fiscalRegimeCodes,
      cfdiUseCode: fiscalCompliance.expectedCfdiUse?.code ?? null,
    },
  });

  if (isFiscalComplianceBlocking(fiscalCompliance)) {
    const userActionResult = buildUserActionRequiredResult({
      reason: fiscalCompliance.reason,
      statusMessage: fiscalCompliance.statusMessage,
      job: jobWithPortalCandidates,
      extracted,
      failure: {
        type: "fiscal_compliance_blocked",
        reason: fiscalCompliance.reason,
        statusMessage: fiscalCompliance.statusMessage,
      },
      editableFields: [],
    });

    return {
      ...extractionPatch,
      ...portalCandidatePatch,
      portalTemplateId: job.portalTemplateId ?? null,
      portalName: job.portalName ?? null,
      portalUrl: job.portalUrl ?? null,
      portalFamily: job.portalFamily ?? null,
      requiredFields: [],
      missingFields: [],
      ...userActionResult,
      error: null,
    };
  }

  if (isAutonomousBillingJob(job) && !isAutonomousOcrAccepted(extracted)) {
    await emit({
      type: "ocr_autonomous_failed",
      status: "failed",
      message: "No fue posible leer con seguridad los datos indispensables del ticket",
      actor: "worker",
      metadata: {
        unresolvedFields: extracted.ocrResolution?.unresolvedFields ?? [],
        candidateSetCount: extracted.ocrResolution?.candidateSets?.length ?? 0,
        evidenceGate: extracted.ocrResolution?.evidenceGate ?? null,
      },
    });
    return buildAutonomousOcrFailureResult({
      extractionPatch,
      portalCandidatePatch,
      extracted,
    });
  }

  if (isAutonomousBillingJob(job) && !cachedExtraction && hooks.stopAfterOcr === true) {
    await emit({
      type: "ocr_handoff_to_portal",
      status: "pending",
      message: "Ticket leido; iniciando generacion de factura",
      actor: "worker",
      metadata: {
        workflowStage: "portal",
        candidateSetCount: extracted.ocrResolution?.candidateSets?.length ?? 1,
      },
    });
    return {
      ...extractionPatch,
      ...portalCandidatePatch,
      status: "pending",
      workflowStage: "portal",
      statusMessage: "Ticket leido; iniciando generacion de factura",
      reason: "ocr_autonomous_completed",
      error: null,
    };
  }

  const mandatoryOcrConfirmation = buildMandatoryOcrConfirmation({
    job: jobWithPortalCandidates,
    extracted,
  });

  if (mandatoryOcrConfirmation.requiresUserAction) {
    await emit({
      type: "ocr_review_required",
      status: "needs_user_action",
      message: mandatoryOcrConfirmation.statusMessage,
      actor: "worker",
      metadata: {
        reason: mandatoryOcrConfirmation.reason,
        reviewMode: mandatoryOcrConfirmation.reviewMode,
        userConfirmed: mandatoryOcrConfirmation.userConfirmed,
        editableFields: mandatoryOcrConfirmation.editableFields.map((field) => field.key ?? field.field ?? field.name),
        missingTicketFields: mandatoryOcrConfirmation.missingTicketFields,
        lowConfidence: mandatoryOcrConfirmation.lowConfidence,
      },
    });

    return {
      ...extractionPatch,
      ...portalCandidatePatch,
      requiredFields: [],
      missingFields: mandatoryOcrConfirmation.editableFields,
      ocrReview: mandatoryOcrConfirmation,
      ocrReviewConfirmed: false,
      ...buildUserActionRequiredResult({
        reason: "ocr_review_required",
        statusMessage: mandatoryOcrConfirmation.statusMessage,
        job: jobWithPortalCandidates,
        extracted,
        editableFields: mandatoryOcrConfirmation.editableFields,
      }),
      error: null,
    };
  }

  const template = await findPortalTemplateByRfc(extracted.rfcEmisor);
  const rememberedManualOutcome = await findRememberedManualOutcome({
    rfcEmisor: extracted.rfcEmisor,
    portalUrl: jobWithPortalCandidates.portalCandidateUrl ?? extracted.portalUrl ?? null,
  });

  if (shouldForceAiNavigation()) {
    const forcedAiResult = await runForcedAiNavigation({
      emit,
      job: jobWithPortalCandidates,
      extracted,
      template,
      hooks,
      extractionPatch: {
        ...extractionPatch,
        ...portalCandidatePatch,
      },
    });

    if (forcedAiResult) {
      return forcedAiResult;
    }
  }

  const rememberedRoute = decideRememberedOutcomeRoute({ rememberedOutcome: rememberedManualOutcome });

  if (rememberedRoute.decision) {
    await emit({
      type: "portal_manual_outcome_remembered",
      status: rememberedRoute.decision === ROUTER_DECISIONS.RESOLVED ? "resolved" : "needs_user_action",
      message: rememberedManualOutcome.statusMessage,
      actor: "worker",
      metadata: {
        rfcEmisor: extracted.rfcEmisor ?? null,
        reason: rememberedManualOutcome.reason,
        portalUrl: rememberedManualOutcome.portalUrl,
        sourcePath: rememberedManualOutcome.sourcePath,
        routerDecision: rememberedRoute.decision,
      },
    });

    return buildRememberedPortalOutcomeResult({
      extractionPatch,
      portalCandidatePatch,
      rememberedOutcome: rememberedManualOutcome,
      job: jobWithPortalCandidates,
      extracted,
      template,
    });
  }

  if (!template) {
    const hasPortal = hasPortalCandidate(jobWithPortalCandidates) || hasPortalCandidate(extracted);
    const ocrReview = applyOcrConfirmationToReview(
      buildOcrFieldReview({ extracted, template: null, requireEmitterRfc: !hasPortal }),
      jobWithPortalCandidates,
      extracted,
    );

    if (ocrReview.requiresUserAction) {
      await emit({
        type: "ocr_review_required",
        status: "needs_user_action",
        message: ocrReview.statusMessage,
        actor: "worker",
        metadata: {
          reason: ocrReview.reason,
          missingTicketFields: ocrReview.missingTicketFields,
          lowConfidence: ocrReview.lowConfidence,
        },
      });

      return {
        ...extractionPatch,
        ...portalCandidatePatch,
        requiredFields: [],
        missingFields: ocrReview.missingTicketFields,
        ocrReview,
        ...buildUserActionRequiredResult({
          reason: "ocr_review_required",
          statusMessage: ocrReview.statusMessage,
          job: jobWithPortalCandidates,
          extracted,
          editableFields: ocrReview.missingTicketFields,
        }),
        error: null,
      };
    }

    await emit({
      type: "portal_missing",
      status: "needs_user_action",
      message: "No hay portal automatizado para este emisor",
      actor: "worker",
      metadata: { rfcEmisor: extracted.rfcEmisor ?? null },
    });

    const b3Fallback = await runB3FallbackIfAvailable({
      emit,
      job: jobWithPortalCandidates,
      extracted,
      template: null,
      hooks,
      context: { ...jobWithPortalCandidates, ...extracted },
      failure: {
        type: "portal_missing",
        reason: "unknown_emitter",
        rfcEmisor: extracted.rfcEmisor ?? null,
      },
    });

    if (b3Fallback) {
      return {
        ...extractionPatch,
        ...portalCandidatePatch,
        requiredFields: [],
        missingFields: [],
        ...b3Fallback,
      };
    }

    return {
      ...extractionPatch,
      ...portalCandidatePatch,
      requiredFields: [],
      missingFields: [],
      fallbackResult: buildFallbackResult({
        reason: "portal_template_missing",
        statusMessage: "No hay portal automatizado ni Capa B disponible para este emisor",
        failure: {
          type: "portal_missing",
          rfcEmisor: extracted.rfcEmisor ?? null,
        },
      }),
      ...buildUserActionRequiredResult({
        reason: "portal_template_missing",
        statusMessage: "No hay portal automatizado para este emisor",
        job: jobWithPortalCandidates,
        extracted,
        failure: {
          type: "portal_missing",
          reason: "portal_template_missing",
          rfcEmisor: extracted.rfcEmisor ?? null,
        },
      }),
      error: null,
    };
  }

  const fieldResolution = resolveTemplateFields(template, {
    ...jobWithPortalCandidates,
    ...extracted,
  });
  await emit({
    type: "portal_matched",
    status: "ocr_processing",
    message: "Portal automatizado encontrado",
    actor: "worker",
    metadata: {
      portalTemplateId: template.id,
      portalName: template.name,
      portalFamily: template.portalFamily ?? null,
    },
  });

  const templatePatch = {
    portalTemplateId: template.id,
    portalName: template.name,
    portalUrl: template.portalUrl,
    portalFamily: template.portalFamily ?? null,
    portalRateLimit: template.rateLimit ?? null,
    portalRateLimitKey: template.rateLimitKey ?? template.portalFamily ?? template.id,
    requiredFields: fieldResolution.requiredFields,
    missingFields: fieldResolution.missingFields,
  };

  const ocrReview = applyOcrConfirmationToReview(
    buildOcrFieldReview({ extracted, template, fieldResolution }),
    jobWithPortalCandidates,
    extracted,
  );

  if (ocrReview.requiresUserAction) {
    await emit({
      type: "ocr_review_required",
      status: "needs_user_action",
      message: ocrReview.statusMessage,
      actor: "worker",
      metadata: {
        portalTemplateId: template.id,
        reason: ocrReview.reason,
        missingTicketFields: ocrReview.missingTicketFields,
        lowConfidence: ocrReview.lowConfidence,
      },
    });

    return {
      ...extractionPatch,
      ...templatePatch,
      ocrReview,
      missingFields: fieldResolution.missingFields,
      ...buildUserActionRequiredResult({
        reason: "ocr_review_required",
        statusMessage: ocrReview.statusMessage,
        job: jobWithPortalCandidates,
        extracted,
        template,
        editableFields: ocrReview.missingTicketFields,
      }),
      error: null,
    };
  }

  if (fieldResolution.missingFields.length) {
    if (isAutonomousBillingJob(jobWithPortalCandidates)) {
      await emit({
        type: "ocr_template_fields_unresolved",
        status: "failed",
        message: "No fue posible obtener los datos que exige este portal",
        actor: "worker",
        metadata: {
          portalTemplateId: template.id,
          missingFields: fieldResolution.missingFields.map((field) => field.name ?? field),
        },
      });
      return {
        ...extractionPatch,
        ...templatePatch,
        status: "failed",
        workflowStage: "complete",
        statusMessage: "No fue posible obtener los datos que exige este portal",
        reason: "ocr_template_fields_unresolved",
        error: {
          code: "ocr_template_fields_unresolved",
          message: "El OCR autonomo agoto sus candidatos sin obtener todos los campos del portal",
          retryable: false,
          fields: fieldResolution.missingFields.map((field) => field.name ?? field),
        },
      };
    }

    await emit({
      type: "missing_fields",
      status: "needs_user_action",
      message: "Faltan datos para facturar en este portal",
      actor: "worker",
      metadata: {
        missingFields: fieldResolution.missingFields.map((field) => field.name ?? field),
      },
    });
    return {
      ...extractionPatch,
      ...templatePatch,
      ...buildUserActionRequiredResult({
        reason: "ocr_review_required",
        statusMessage: "Faltan datos para facturar en este portal",
        job: jobWithPortalCandidates,
        extracted,
        template,
        portalRunResult: {
          reason: "ocr_review_required",
          missingFields: fieldResolution.missingFields,
        },
        editableFields: fieldResolution.missingFields,
      }),
      error: null,
    };
  }

  let portalContext = {
    ...jobWithPortalCandidates,
    ...extracted,
    ...fieldResolution.resolved,
    assertClaimActive: hooks.assertClaimActive,
  };
  const preflightResult = evaluateTemplatePreflight(template, portalContext, {
    now: hooks.now,
  });

  if (preflightResult.blocked) {
    await rememberPortalOutcome({
      rfcEmisor: extracted.rfcEmisor,
      portalUrl: template.portalUrl,
      reason: preflightResult.reason,
      status: preflightResult.status ?? "needs_user_action",
      statusMessage: preflightResult.statusMessage,
      source: "template_preflight",
      templateId: template.id,
      portalFamily: template.portalFamily ?? null,
    });

    await emit({
      type: "portal_preflight_blocked",
      status: preflightResult.status ?? "needs_user_action",
      message: preflightResult.statusMessage ?? "El portal no puede procesar este ticket",
      actor: "worker",
      metadata: {
        portalTemplateId: template.id,
        reason: preflightResult.reason ?? "preflight_rule_blocked",
        details: preflightResult.details ?? null,
      },
    });

    return {
      ...extractionPatch,
      ...templatePatch,
      portalPreflightResult: preflightResult,
      ...buildUserActionRequiredResult({
        reason: preflightResult.reason ?? "portal_blocked",
        statusMessage: preflightResult.statusMessage ?? "El portal no puede procesar este ticket",
        job: jobWithPortalCandidates,
        extracted,
        template,
        portalRunResult: preflightResult,
      }),
      error: null,
    };
  }

  const autopilotDecision = buildAutopilotDecision({
    job: jobWithPortalCandidates,
    extracted,
    template,
    fieldResolution,
    preflightResult,
  });
  portalContext = applyAutopilotApprovalToContext(portalContext, autopilotDecision);

  await emit({
    type: "autopilot_decision",
    status: "portal_processing",
    message: autopilotDecision.approveFinalSubmit
      ? "Autopilot listo para emitir si el portal valida el ticket"
      : "Autopilot no aprobo emision automatica",
    actor: "worker",
    metadata: {
      portalTemplateId: template.id,
      approvalSource: autopilotDecision.approvalSource,
      blockedBy: autopilotDecision.blockedBy,
      lowConfidence: autopilotDecision.ocrReview?.lowConfidence ?? [],
    },
  });
  const autopilotPatch = { autopilotDecision };

  await emit({
    type: "portal_started",
    status: "portal_processing",
    message: "Ejecucion de portal iniciada",
    actor: "worker",
    metadata: { portalTemplateId: template.id },
  });
  let templateResult = null;
  let selectedAttempt = null;
  let portalAttemptResults = [];

  try {
    const attempts = buildPortalAttemptContexts({ baseContext: portalContext, extracted });

    for (const attempt of attempts) {
      if (attempt.index > 1) {
        await emit({
          type: "portal_retry_variant_started",
          status: "portal_processing",
          message: "El portal rechazo el ticket; probando variante OCR",
          actor: "worker",
          metadata: {
            portalTemplateId: template.id,
            attemptIndex: attempt.index,
            maxAttempts: attempts.length,
            variant: attempt.variant,
          },
        });
      }

      const attemptResult = await runWithPortalRateLimit(
        template,
        () => runPortalTemplate(template, attempt.context),
        { signal: hooks.signal },
      );
      portalAttemptResults = [
        ...portalAttemptResults,
        {
          index: attempt.index,
          variant: attempt.variant,
          status: attemptResult.status ?? (attemptResult.safeStop ? "needs_user_action" : "completed"),
          reason: attemptResult.reason ?? null,
        },
      ];

      if (shouldRetryPortalAttempt(attemptResult) && attempt.index < attempts.length) {
        await emit({
          type: "portal_retry_variant_scheduled",
          status: "portal_processing",
          message: "Validacion de ticket rechazada; se intentara otra lectura OCR",
          actor: "worker",
          metadata: {
            portalTemplateId: template.id,
            attemptIndex: attempt.index,
            reason: attemptResult.reason ?? null,
            portalMessage: attemptResult.portalMessage ?? null,
            nextAttemptIndex: attempt.index + 1,
          },
        });
        continue;
      }

      templateResult = {
        ...attemptResult,
        portalAttempt: attempt,
        portalAttemptResults,
      };
      portalContext = attempt.context;
      selectedAttempt = attempt;
      break;
    }
  } catch (error) {
    const templateFailureReason = error?.code === "cfdi_artifact_missing"
      ? "cfdi_artifact_missing"
      : "template_runtime_error";
    if (template?.id) {
      await degradeTemplateCandidate({ templateId: template.id, reason: templateFailureReason }).catch(() => {});
    }
    const b3Fallback = await runB3FallbackIfAvailable({
      emit,
      job: jobWithPortalCandidates,
      extracted,
      template,
      hooks,
      context: portalContext,
      failure: {
        type: "template_exception",
        reason: templateFailureReason,
        message: error.message,
      },
    });

    if (b3Fallback) {
      return {
        ...extractionPatch,
        ...templatePatch,
        ...autopilotPatch,
        ...b3Fallback,
      };
    }

    throw error;
  }

  const finalExtractionPatch = applySelectedVariantToExtractionPatch(extractionPatch, selectedAttempt?.variant);

  if (templateResult?.safeStop) {
    const safeStopResult = await materializePortalArtifacts({
      job,
      templateResult,
    });
    await rememberPortalOutcome({
      rfcEmisor: extracted.rfcEmisor,
      portalUrl: safeStopResult.currentUrl ?? safeStopResult.portalUrl ?? template.portalUrl,
      reason: safeStopResult.reason,
      status: safeStopResult.status ?? "needs_user_action",
      statusMessage: safeStopResult.statusMessage,
      source: "template_safe_stop",
      templateId: template.id,
      portalFamily: template.portalFamily ?? null,
      metadata: {
        safeStop: true,
      },
    });

    await emit({
      type: "portal_safe_stop",
      status: safeStopResult.status ?? "needs_user_action",
      message: safeStopResult.statusMessage ?? "Ejecucion detenida antes del paso final",
      actor: "worker",
      metadata: {
        portalTemplateId: template.id,
        reason: safeStopResult.reason ?? "template_safe_stop",
        screenshotStoragePath: safeStopResult.artifacts?.screenshotStoragePath ?? null,
        htmlStoragePath: safeStopResult.artifacts?.htmlStoragePath ?? null,
      },
    });

    if (shouldRecoverOxxoWithReprint({ template, templateResult: safeStopResult })) {
      const recovered = await recoverSafelyWithOxxoReprint({
        emit,
        job,
        template,
        signal: hooks.signal,
        portalContext,
        safeStopResult,
        extracted,
        extractionPatch: finalExtractionPatch,
        templatePatch: {
          ...templatePatch,
          ...autopilotPatch,
        },
      });

      if (recovered) {
        return recovered;
      }
    }

    if (isAlreadyInvoicedReason(safeStopResult.reason)) {
      return {
        ...finalExtractionPatch,
        ...templatePatch,
        ...autopilotPatch,
        portalRunResult: safeStopResult,
        ...buildResolvedAlreadyInvoicedResult({
          job,
          extracted,
          template,
          portalRunResult: safeStopResult,
        }),
      };
    }

    if (shouldTryAiNavigationForSafeStop(safeStopResult)) {
      const b3Fallback = await runB3FallbackIfAvailable({
        emit,
        job: jobWithPortalCandidates,
        extracted,
        template,
        hooks,
        context: portalContext,
        failure: {
          type: "template_safe_stop",
          reason: safeStopResult.reason ?? "template_safe_stop",
          statusMessage: safeStopResult.statusMessage ?? null,
        },
      });

      if (b3Fallback) {
        return {
          ...finalExtractionPatch,
          ...templatePatch,
          ...autopilotPatch,
          portalRunResult: safeStopResult,
          ...b3Fallback,
        };
      }
    }

    return {
      ...finalExtractionPatch,
      ...templatePatch,
      ...autopilotPatch,
      portalRunResult: safeStopResult,
      ...buildUserActionRequiredResult({
        reason: safeStopResult.reason ?? "template_safe_stop",
        statusMessage: safeStopResult.statusMessage ?? "Ejecucion detenida antes del paso final",
        job: jobWithPortalCandidates,
        extracted,
        template,
        portalRunResult: safeStopResult,
      }),
      error: null,
    };
  }

  await emit({
    type: "portal_completed",
    status: "portal_processing",
    message: "Portal ejecutado correctamente",
    actor: "worker",
    metadata: {
      xmlUrl: templateResult.xmlUrl ?? null,
      pdfUrl: templateResult.pdfUrl ?? null,
    },
  });
  let cfdiResult = null;
  try {
    cfdiResult = await materializeCfdiResult({
      job,
      template,
      templateResult,
      extracted,
    });
  } catch (error) {
    if (error?.code !== "cfdi_artifact_missing") throw error;

    if (template?.id) {
      await degradeTemplateCandidate({
        templateId: template.id,
        reason: "cfdi_artifact_missing",
      }).catch(() => {});
    }
    await emit({
      type: "portal_template_artifact_missing",
      status: "portal_processing",
      message: "La receta no produjo un CFDI real; se intentara resolver con Capa B3",
      actor: "worker",
      metadata: {
        portalTemplateId: template?.id ?? null,
        missingArtifact: error.kind ?? null,
        sourceUrl: error.sourceUrl ?? null,
      },
    });
    const b3Fallback = await runB3FallbackIfAvailable({
      emit,
      job: jobWithPortalCandidates,
      extracted,
      template,
      hooks,
      context: portalContext,
      failure: {
        type: "template_artifact_missing",
        reason: "cfdi_artifact_missing",
        message: error.message,
      },
    });

    if (b3Fallback) {
      return {
        ...finalExtractionPatch,
        ...templatePatch,
        ...autopilotPatch,
        ...b3Fallback,
      };
    }
    throw error;
  }
  await emit({
    type: "cfdi_stored",
    status: "portal_processing",
    message: "CFDI guardado",
    actor: "worker",
    metadata: {
      cfdiStorageMode: cfdiResult.cfdiStorageMode ?? null,
      resultXmlStoragePath: cfdiResult.resultXmlStoragePath ?? null,
      resultPdfStoragePath: cfdiResult.resultPdfStoragePath ?? null,
    },
  });

  return {
    ...finalExtractionPatch,
    ...templatePatch,
    ...autopilotPatch,
    ...cfdiResult,
    status: "completed",
    statusMessage: buildCompletedMessage(extracted),
    error: null,
  };
}

async function runForcedAiNavigation({ emit, job, extracted, template, hooks = {}, extractionPatch }) {
  const hasPortal = hasPortalCandidate(job) || hasPortalCandidate(extracted) || Boolean(template);
  const ocrReview = applyOcrConfirmationToReview(
    buildOcrFieldReview({ extracted, template, requireEmitterRfc: !hasPortal }),
    job,
    extracted,
  );

  if (ocrReview.requiresUserAction) {
    await emit({
      type: "ocr_review_required",
      status: "needs_user_action",
      message: ocrReview.statusMessage,
      actor: "worker",
      metadata: {
        portalTemplateId: template?.id ?? null,
        reason: ocrReview.reason,
        missingTicketFields: ocrReview.missingTicketFields,
        lowConfidence: ocrReview.lowConfidence,
        forcedAiNavigation: true,
      },
    });

    return {
      ...extractionPatch,
      portalTemplateId: template?.id ?? null,
      portalName: template?.name ?? null,
      portalUrl: template?.portalUrl ?? null,
      ocrReview,
      missingFields: ocrReview.missingTicketFields,
      status: "needs_user_action",
      statusMessage: ocrReview.statusMessage,
      error: null,
    };
  }

  await emit({
    type: "b3_browseruse_forced",
    status: "portal_processing",
    message: "Capa B3 browser-use forzada para prueba de laboratorio",
    actor: "worker",
    metadata: {
      portalTemplateId: template?.id ?? null,
      portalName: template?.name ?? null,
      rfcEmisor: extracted.rfcEmisor ?? null,
    },
  });

  const context = template
    ? {
        ...job,
        ...extracted,
        portalUrl: job.aiPortalUrl ?? job.portalCandidateUrl ?? job.portalUrl ?? template.portalUrl,
      }
    : { ...job, ...extracted };

  const b3Fallback = await runB3FallbackIfAvailable({
    emit,
    job,
    extracted,
    template,
    hooks,
    context,
    failure: {
      type: "forced_ai_navigation",
      reason: "lab_forced_layer_b",
      statusMessage: "Capa B fue forzada por configuracion de laboratorio",
    },
  });

  if (!b3Fallback) {
    return {
      ...extractionPatch,
      portalTemplateId: template?.id ?? null,
      portalName: template?.name ?? null,
      portalUrl: template?.portalUrl ?? null,
      fallbackResult: buildFallbackResult({
        reason: "b3_browseruse_disabled",
        statusMessage: "Capa B3 esta deshabilitada aunque fue solicitada por laboratorio",
        failure: {
          type: "forced_b3_browseruse",
          reason: "lab_forced_layer_b",
        },
      }),
      status: "needs_user_action",
      statusMessage: "Capa B3 esta deshabilitada",
      error: null,
    };
  }

  return {
    ...extractionPatch,
    portalTemplateId: template?.id ?? null,
    portalName: template?.name ?? null,
    portalUrl: template?.portalUrl ?? null,
    forcedAiNavigation: true,
    ...b3Fallback,
  };
}

async function runB3FallbackIfAvailable({ emit, job, extracted, template, hooks = {}, context = {}, failure }) {
  if (!canRunB3BrowserUse()) {
    return null;
  }

  const rememberedOutcome = await findRememberedManualOutcome({
    rfcEmisor: extracted?.rfcEmisor,
    portalUrl:
      context?.aiPortalUrl ??
      context?.portalCandidateUrl ??
      context?.portalUrl ??
      extracted?.portalUrl ??
      template?.portalUrl ??
      null,
  });
  const route = decideB3Route({ failure, rememberedOutcome });

  if (route.decision !== ROUTER_DECISIONS.RUN_B3) {
    await emit({
      type: "b3_browseruse_skipped",
      status: route.decision === ROUTER_DECISIONS.RESOLVED ? "resolved" : "needs_user_action",
      message: rememberedOutcome?.statusMessage ?? "Capa B3 omitida por politica del orquestador",
      actor: "worker",
      metadata: {
        routerDecision: route.decision,
        reason: route.reason ?? failure?.reason ?? null,
        source: route.source,
        rfcEmisor: extracted?.rfcEmisor ?? null,
        portalUrl: rememberedOutcome?.portalUrl ?? null,
      },
    });

    if (rememberedOutcome) {
      return buildRememberedPortalOutcomeResult({
        extractionPatch: {},
        portalCandidatePatch: {},
        rememberedOutcome,
        job,
        extracted,
        template,
      });
    }

    return null;
  }

  const maxAttempts = process.env.ENABLE_B3_RETRY_ON_FAILURE !== "false" ? 2 : 1;
  let currentFailure = failure;
  let finalResultContext = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await emit({
      type: attempt === 1 ? "b3_browseruse_started" : "b3_browseruse_retry_started",
      status: "portal_processing",
      message: attempt === 1 ? "Generando factura en el portal" : `Iniciando intento ${attempt} de Capa B3 para resolver error previo`,
      actor: "worker",
      metadata: {
        portalTemplateId: template?.id ?? null,
        reason: currentFailure?.reason ?? null,
        rfcEmisor: extracted?.rfcEmisor ?? null,
        portalUrl:
          context?.aiPortalUrl ??
          context?.portalCandidateUrl ??
          context?.portalUrl ??
          extracted?.portalUrl ??
          template?.portalUrl ??
          null,
        model: process.env.B3_BROWSER_USE_MODEL ?? "gemini-3.1-flash-lite",
        attempt,
        maxAttempts,
      },
    });

    if (attempt === 1) {
      await emit({
        type: "b3_searching_portal",
        status: "portal_processing",
        message: "Buscando y preparando portal de facturacion",
        actor: "worker",
        metadata: {
          reason: currentFailure?.reason ?? null,
          rfcEmisor: extracted?.rfcEmisor ?? null,
        },
      });
    }

    await hooks.assertClaimActive?.();
    const b3PortalUrl =
      context?.aiPortalUrl ??
      context?.portalCandidateUrl ??
      context?.portalUrl ??
      extracted?.portalUrl ??
      template?.portalUrl ??
      null;
    const rateLimitTarget = template ?? {
      portalUrl: b3PortalUrl,
      rfcEmisor: extracted?.rfcEmisor ?? job?.rfcEmisor ?? null,
      rateLimitKey: b3PortalUrl ? null : `b3-discovery:${extracted?.rfcEmisor ?? job?.rfcEmisor ?? "unknown"}`,
      rateLimit: { concurrency: 1, perMinute: 6 },
    };
    const result = await runWithPortalRateLimit(
      rateLimitTarget,
      () => runB3BrowserUseFallback({
        job,
        extracted,
        taxProfile: job?.taxProfile,
        fiscalCompliance:
          context?.fiscalCompliance ?? job?.fiscalCompliance ?? buildFiscalComplianceContext(job?.taxProfile),
        portalUrl: b3PortalUrl,
        template,
        failure: currentFailure,
        signal: hooks.signal,
      }),
      { signal: hooks.signal },
    );

    if (!result) {
      return null;
    }

    const usageTelemetry = buildB3UsageTelemetry({
      jobId: job?.id,
      model: process.env.B3_BROWSER_USE_MODEL ?? "gemini-3.1-flash-lite",
      attempt,
      usage: result.usage,
    });

    if (usageTelemetry) {
      const logMethod = usageTelemetry.severity === "critical"
        ? "error"
        : usageTelemetry.severity === "warning"
        ? "warn"
        : "info";
      logger[logMethod]("B3 LLM usage recorded.", usageTelemetry);
      await emit({
        type: "b3_llm_usage",
        status: "portal_processing",
        message: "Consumo del modelo B3 registrado",
        actor: "worker",
        metadata: usageTelemetry,
      });
    }

    const rememberedB3Outcome = await rememberPortalOutcome({
      rfcEmisor: extracted?.rfcEmisor ?? job?.rfcEmisor,
      portalUrl: result.currentUrl ?? result.portalUrl ?? context?.portalUrl ?? template?.portalUrl ?? null,
      reason: result.reason,
      status: result.status,
      statusMessage: result.statusMessage,
      source: "b3_browseruse",
      templateId: template?.id ?? null,
      portalFamily: template?.portalFamily ?? null,
      metadata: {
        failureReason: currentFailure?.reason ?? null,
        learnedTemplatePath: result.learnedTemplateSave?.path ?? null,
      },
    });

    if (rememberedB3Outcome) {
      await emit({
        type: "b3_detected_manual_block",
        status: "portal_processing",
        message: rememberedB3Outcome.statusMessage,
        actor: "worker",
        metadata: {
          reason: rememberedB3Outcome.reason,
          failureCount: rememberedB3Outcome.failureCount ?? null,
          portalHost: rememberedB3Outcome.portalHost ?? null,
        },
      });
    }

    if (result.learnedTemplateSave || result.b3ToABridge?.result?.compiledPath) {
      await emit({
        type: "b3_learning_recipe",
        status: "portal_processing",
        message: "Capa B3 genero aprendizaje para Capa A",
        actor: "worker",
        metadata: {
          learnedTemplateSave: result.learnedTemplateSave ?? null,
          compiledPath: result.b3ToABridge?.result?.compiledPath ?? null,
        },
      });
    }

    await emit({
      type: "b3_browseruse_completed",
      status: result.status ?? "needs_user_action",
      message: result.statusMessage ?? "Capa B3 browser-use completada",
      actor: "worker",
      metadata: {
        portalTemplateId: template?.id ?? null,
        reason: result.reason ?? null,
        currentUrl: result.currentUrl ?? null,
        downloadedXml: result.downloadedXml ?? null,
        downloadedPdf: result.downloadedPdf ?? null,
        learnedTemplateSave: result.learnedTemplateSave ?? null,
        b3ToABridge: summarizeB3Bridge(result.b3ToABridge),
        usage: result.usage ?? null,
        attempt,
      },
    });

    const isSuccess = result.status === "completed" && (b3ResultHasCfdi(result) || b3ResultHasFiscalXml(result));
    const isPartialSuccess = result.xmlPath || result.xmlUrl || result.pdfPath || result.pdfUrl;
    const isHardManualStop = shouldStopB3Retries(result);

    if (isSuccess || isPartialSuccess || isHardManualStop || attempt === maxAttempts) {
      finalResultContext = result;
      break;
    }

    currentFailure = {
      type: "b3_retry_context",
      reason: result.reason ?? "unknown_error",
      statusMessage: result.statusMessage ?? "Falló el intento previo",
      previousResult: {
        status: result.status,
        reason: result.reason,
        statusMessage: result.statusMessage,
        currentUrl: result.currentUrl,
        executionError: result.executionError,
      }
    };
  }

  const result = finalResultContext;

  if (result.status === "completed" && b3ResultHasCfdi(result)) {
    const cfdiResult = await materializeCfdiResult({
      job,
      template: template ?? {
        id: "b3-browseruse",
        rfcEmisor: extracted.rfcEmisor ?? job.rfcEmisor ?? "unknown",
      },
      templateResult: result,
      extracted,
    });

    await emit({
      type: "cfdi_stored",
      status: "portal_processing",
      message: "CFDI guardado desde Capa B3 browser-use",
      actor: "worker",
      metadata: {
        cfdiStorageMode: cfdiResult.cfdiStorageMode ?? null,
        resultXmlStoragePath: cfdiResult.resultXmlStoragePath ?? null,
        resultPdfStoragePath: cfdiResult.resultPdfStoragePath ?? null,
        learnedTemplateSave: result.learnedTemplateSave ?? null,
        b3ToABridge: summarizeB3Bridge(result.b3ToABridge),
      },
    });

    return {
      ...cfdiResult,
      aiNavigationResult: buildB3NavigationResult({ result, failure }),
      portalLearningState: result.learnedTemplateSave?.learningState ?? null,
      status: "completed",
      statusMessage: "Factura generada correctamente. XML y PDF guardados.",
      reason: result.reason ?? "cfdi_downloaded",
      error: null,
    };
  }

  if (result.status === "completed" && b3ResultHasFiscalXml(result)) {
    const cfdiResult = await materializeAvailableCfdiResult({
      job,
      templateResult: result,
      template,
      extracted,
    });

    await emit({
      type: "cfdi_stored_with_warning",
      status: "completed",
      message: "CFDI XML guardado desde Capa B3; PDF no disponible",
      actor: "worker",
      metadata: {
        cfdiStorageMode: cfdiResult.cfdiStorageMode ?? null,
        resultXmlStoragePath: cfdiResult.resultXmlStoragePath ?? null,
        resultPdfStoragePath: cfdiResult.resultPdfStoragePath ?? null,
        reason: result.reason ?? null,
      },
    });

    return {
      ...cfdiResult,
      aiNavigationResult: buildB3NavigationResult({ result, failure }),
      portalLearningState: result.learnedTemplateSave?.learningState ?? null,
      status: "completed",
      statusMessage: "Factura generada correctamente. XML guardado; PDF no disponible.",
      reason: result.reason ?? "cfdi_xml_downloaded_pdf_missing",
      warnings: [
        ...(toArray(job.warnings)),
        {
          code: "pdf_missing",
          message: "El XML fiscal fue descargado y guardado, pero no se obtuvo PDF.",
        },
      ],
      error: null,
    };
  }

  if (result.xmlPath || result.xmlUrl || result.pdfPath || result.pdfUrl) {
    const partialCfdiResult = await materializeAvailableCfdiResult({
      job,
      templateResult: result,
      template,
      extracted,
    });

    await emit({
      type: "cfdi_partial_stored",
      status: "needs_user_action",
      message:
        result.reason === "pdf_downloaded_xml_missing"
          ? "PDF guardado desde Capa B3; falta XML"
          : "CFDI parcial guardado desde Capa B3",
      actor: "worker",
      metadata: {
        cfdiStorageMode: partialCfdiResult.cfdiStorageMode ?? null,
        resultXmlStoragePath: partialCfdiResult.resultXmlStoragePath ?? null,
        resultPdfStoragePath: partialCfdiResult.resultPdfStoragePath ?? null,
        reason: result.reason ?? null,
      },
    });

    return {
      ...partialCfdiResult,
      aiNavigationResult: buildB3NavigationResult({ result, failure }),
      portalLearningState: result.learnedTemplateSave?.learningState ?? null,
      status: "needs_user_action",
      statusMessage:
        result.reason === "pdf_downloaded_xml_missing"
          ? "Se descargó y guardó el PDF, pero falta descargar el XML fiscal."
          : result.statusMessage ?? "Capa B3 descargó archivos parciales del CFDI.",
      reason: result.reason ?? "cfdi_partial_download",
      error: null,
    };
  }

  const userActionResult = isAlreadyInvoicedReason(result.reason)
    ? buildResolvedAlreadyInvoicedResult({
        job,
        extracted,
        template,
        portalRunResult: result,
      })
    : buildUserActionRequiredResult({
        reason: result.reason ?? "b3_browseruse_unresolved",
        statusMessage: result.statusMessage ?? "Capa B3 browser-use requiere intervencion",
        job,
        extracted,
        template,
        portalRunResult: result,
        failure,
      });

  return {
    aiNavigationResult: buildB3NavigationResult({ result, failure }),
    portalLearningState: result.learnedTemplateSave?.learningState ?? null,
    ...userActionResult,
    fallbackResult:
      userActionResult.status === "resolved"
        ? null
        : buildFallbackResult({
            reason: result.reason ?? "b3_browseruse_unresolved",
            statusMessage: result.statusMessage ?? "Capa B3 browser-use requiere intervencion",
            failure,
          }),
    error: null,
  };
}

function buildB3NavigationResult({ result, failure }) {
  return {
    providerMode: "b3_browseruse",
    provider: "browser-use",
    model: process.env.B3_BROWSER_USE_MODEL ?? "gemini-3.1-flash-lite",
    status: result.status ?? null,
    reason: result.reason ?? null,
    statusMessage: result.statusMessage ?? null,
    currentUrl: result.currentUrl ?? null,
    downloads: result.downloads ?? [],
    artifacts: result.artifacts ?? null,
    trace: result.trace ?? null,
    usage: result.usage ?? null,
    learnedTemplateSave: result.learnedTemplateSave ?? null,
    b3ToABridge: summarizeB3Bridge(result.b3ToABridge),
    failure,
  };
}

function buildRememberedPortalOutcomeResult({
  extractionPatch = {},
  portalCandidatePatch = {},
  rememberedOutcome,
  job,
  extracted,
  template = null,
}) {
  const rememberedJob = {
    ...job,
    portalCandidateUrl: rememberedOutcome.portalUrl ?? job.portalCandidateUrl,
    portalUrl: rememberedOutcome.portalUrl ?? job.portalUrl,
    portalTemplateId: template?.id ?? rememberedOutcome.templateId ?? job.portalTemplateId,
    portalName: template?.name ?? job.portalName,
    portalFamily: template?.portalFamily ?? rememberedOutcome.portalFamily ?? job.portalFamily,
  };
  const portalRunResult = {
    safeStop: true,
    reason: rememberedOutcome.reason,
    statusMessage: rememberedOutcome.statusMessage,
    currentUrl: rememberedOutcome.portalUrl,
    portalUrl: rememberedOutcome.portalUrl,
  };

  if (isAlreadyInvoicedReason(rememberedOutcome.reason)) {
    return {
      ...extractionPatch,
      ...portalCandidatePatch,
      requiredFields: [],
      missingFields: [],
      portalLearningState: "manual_outcome_remembered",
      rememberedManualOutcome: rememberedOutcome,
      ...buildResolvedAlreadyInvoicedResult({
        job: rememberedJob,
        extracted,
        template,
        portalRunResult,
      }),
    };
  }

  return {
    ...extractionPatch,
    ...portalCandidatePatch,
    portalTemplateId: template?.id ?? rememberedOutcome.templateId ?? job.portalTemplateId ?? null,
    portalName: template?.name ?? job.portalName ?? null,
    portalUrl: rememberedOutcome.portalUrl ?? template?.portalUrl ?? job.portalUrl ?? null,
    portalFamily: template?.portalFamily ?? rememberedOutcome.portalFamily ?? job.portalFamily ?? null,
    requiredFields: [],
    missingFields: [],
    portalLearningState: "manual_outcome_remembered",
    rememberedManualOutcome: rememberedOutcome,
    ...buildUserActionRequiredResult({
      reason: rememberedOutcome.reason,
      statusMessage: rememberedOutcome.statusMessage,
      job: rememberedJob,
      extracted,
      template,
      portalRunResult,
    }),
    fallbackResult: buildFallbackResult({
      reason: rememberedOutcome.reason,
      statusMessage: rememberedOutcome.statusMessage,
      failure: {
        type: "remembered_manual_outcome",
        reason: rememberedOutcome.reason,
        sourcePath: rememberedOutcome.sourcePath,
      },
    }),
    error: null,
  };
}

function summarizeB3Bridge(bridge) {
  if (!bridge) {
    return null;
  }

  return {
    ok: bridge.ok ?? null,
    exitCode: bridge.exitCode ?? null,
    stage: bridge.stage ?? bridge.result?.stage ?? null,
    compiledPath: bridge.result?.compiledPath ?? null,
    compile: bridge.result?.compile ?? null,
    replayStatus: bridge.result?.replay?.status ?? null,
    replayReason: bridge.result?.replay?.reason ?? null,
    replayError: truncateBridgeMessage(bridge.result?.replay?.error),
    error: truncateBridgeMessage(bridge.result?.error),
    persistenceErrors: bridge.result?.persistenceErrors ?? [],
  };
}

function truncateBridgeMessage(value) {
  return value ? String(value).slice(0, 1_000) : null;
}

async function buildPortalCandidatePatch(job, extracted) {
  const discoveryCandidates = toArray(extracted?.portalDiscovery?.portalCandidates);
  const qrDiscoveryCandidates = discoveryCandidates.filter(isQrPortalCandidate);
  const directoryCandidates = await findPortalCandidatesByRfc(extracted.rfcEmisor);
  const jobCandidates = buildExistingJobPortalCandidates(job);

  if (qrDiscoveryCandidates.length) {
    const portalCandidates = uniquePortalCandidates([
      ...qrDiscoveryCandidates,
      ...directoryCandidates,
      ...jobCandidates,
      ...discoveryCandidates.filter((candidate) => !isQrPortalCandidate(candidate)),
    ]);

    return {
      aiPortalUrl: qrDiscoveryCandidates[0].url,
      portalCandidateUrl: qrDiscoveryCandidates[0].url,
      portalCandidates,
    };
  }

  if (hasPortalCandidate(job)) {
    const portalCandidates = uniquePortalCandidates([
      ...jobCandidates,
      ...directoryCandidates,
      ...discoveryCandidates,
    ]);

    return portalCandidates.length
      ? {
          portalCandidates,
        }
      : {};
  }

  if (directoryCandidates.length) {
    const portalCandidates = uniquePortalCandidates([
      ...directoryCandidates,
      ...discoveryCandidates,
    ]);

    return {
      aiPortalUrl: directoryCandidates[0].url,
      portalCandidateUrl: directoryCandidates[0].url,
      portalCandidates,
    };
  }

  if (discoveryCandidates.length) {
    return {
      aiPortalUrl: discoveryCandidates[0].url,
      portalCandidateUrl: discoveryCandidates[0].url,
      portalCandidates: uniquePortalCandidates(discoveryCandidates),
    };
  }

  if (hasPortalCandidate(extracted)) {
    return {};
  }

  return {};
}

async function runPortalDiscoveryIfEnabled({ emit, job, extracted, probeUrls = true }) {
  if (!isPortalDiscoveryEnabled()) {
    return null;
  }

  await emit({
    type: "portal_discovery_started",
    status: "ocr_processing",
    message: "Buscando URL/QR de facturacion en el ticket",
    actor: "worker",
    metadata: {
      rfcEmisor: extracted.rfcEmisor ?? null,
    },
  });

  try {
    const discovery = await discoverPortalFromTicket({ job, extracted, probeUrls });

    await emit({
      type: "portal_discovery_completed",
      status: "ocr_processing",
      message: discovery.bestCandidate
        ? "Portal candidato detectado desde ticket"
        : "No se detecto portal candidato en el ticket",
      actor: "worker",
      metadata: {
        status: discovery.status,
        fieldNames: Object.keys(discovery.fields ?? {}),
        qrValuesFound: discovery.qrValues?.length ?? 0,
        portalCandidateUrl: discovery.bestCandidate?.url ?? null,
        portalCandidateCount: discovery.portalCandidates?.length ?? 0,
      },
    });

    return discovery;
  } catch (error) {
    await emit({
      type: "portal_discovery_failed",
      status: "ocr_processing",
      message: "No se pudo completar discovery de portal",
      actor: "worker",
      metadata: {
        error: error.message,
      },
    });

    return {
      status: "failed",
      error: error.message,
      fields: {},
      qrValues: [],
      urlCandidates: [],
      portalCandidates: [],
      bestCandidate: null,
      probeResults: [],
    };
  }
}

function hasPortalCandidate(value) {
  return Boolean(
    firstString(value?.aiPortalUrl) ||
      firstString(value?.portalCandidateUrl) ||
      firstString(value?.portalUrl) ||
      firstString(value?.portalCandidates?.[0]?.url),
  );
}

function buildExistingJobPortalCandidates(job) {
  const candidates = [];
  const add = (url, source) => {
    const normalizedUrl = firstString(url);

    if (!normalizedUrl) {
      return;
    }

    candidates.push({
      url: normalizedUrl,
      source,
      confidence: 0.86,
    });
  };

  for (const candidate of toArray(job.portalCandidates)) {
    if (candidate?.url) {
      candidates.push(candidate);
    }
  }

  add(job.aiPortalUrl, "job.aiPortalUrl");
  add(job.portalCandidateUrl, "job.portalCandidateUrl");
  add(job.portalUrl, "job.portalUrl");

  return candidates;
}

function uniquePortalCandidates(candidates) {
  const seen = new Set();
  const unique = [];

  for (const candidate of candidates) {
    const url = firstString(candidate?.url);

    if (!url || seen.has(url)) {
      continue;
    }

    seen.add(url);
    unique.push({
      ...candidate,
      url,
    });
  }

  return unique;
}

function isQrPortalCandidate(candidate) {
  const source = String(candidate?.source ?? "");
  const originSource = String(candidate?.originSource ?? "");

  return source === "qr" || source.startsWith("qr_") || originSource === "qr";
}

function firstString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

async function recoverSafelyWithOxxoReprint({
  emit,
  job,
  template,
  signal = null,
  portalContext,
  safeStopResult,
  extracted,
  extractionPatch,
  templatePatch,
}) {
  await emit({
    type: "portal_recovery_started",
    status: "portal_processing",
    message: "Recuperacion OXXO por reimpresion iniciada",
    actor: "worker",
    metadata: {
      portalTemplateId: template.id,
      previousReason: safeStopResult.reason ?? null,
      recoveryType: "oxxo_reprint",
    },
  });

  try {
    const recoveryResult = await runWithPortalRateLimit(
      template,
      () => recoverOxxoCfdiByReprint({
        job,
        template,
        context: portalContext,
      }),
      { signal },
    );
    const cfdiResult = await materializeCfdiResult({
      job,
      template,
      templateResult: recoveryResult,
      extracted,
    });
    const portalRunResult = {
      status: "completed",
      statusMessage: "OXXO factura descargada desde reimpresion",
      reason: "cfdi_downloaded_from_reprint",
      previousReason: safeStopResult.reason ?? null,
      templateId: template.id,
      jobId: job.id,
      artifacts: recoveryResult.artifacts ?? null,
      recovery: recoveryResult.recovery ?? { type: "oxxo_reprint" },
      xmlUrl: cfdiResult.resultXmlUrl,
      pdfUrl: cfdiResult.resultPdfUrl,
      downloadMode: recoveryResult.downloadMode ?? "oxxo_reprint",
    };

    await emit({
      type: "portal_recovery_completed",
      status: "portal_processing",
      message: "Recuperacion OXXO por reimpresion completada",
      actor: "worker",
      metadata: {
        portalTemplateId: template.id,
        recoveryType: "oxxo_reprint",
      },
    });
    await emit({
      type: "cfdi_stored",
      status: "portal_processing",
      message: "CFDI guardado",
      actor: "worker",
      metadata: {
        cfdiStorageMode: cfdiResult.cfdiStorageMode ?? null,
        resultXmlStoragePath: cfdiResult.resultXmlStoragePath ?? null,
        resultPdfStoragePath: cfdiResult.resultPdfStoragePath ?? null,
        downloadMode: recoveryResult.downloadMode ?? "oxxo_reprint",
      },
    });

    return {
      ...extractionPatch,
      ...templatePatch,
      ...cfdiResult,
      portalRunResult,
      status: "completed",
      statusMessage: "Factura OXXO emitida, descargada y guardada",
      error: null,
    };
  } catch (error) {
    await emit({
      type: "portal_recovery_failed",
      status: "needs_user_action",
      message: "No se pudo recuperar el CFDI OXXO por reimpresion",
      actor: "worker",
      metadata: {
        portalTemplateId: template.id,
        recoveryType: "oxxo_reprint",
        error: error.message,
      },
    });

    safeStopResult.recoveryAttempt = {
      type: "oxxo_reprint",
      status: "failed",
      error: error.message,
    };
    safeStopResult.statusMessage = "OXXO genero la factura, pero no se pudo recuperar el CFDI por reimpresion";
    return null;
  }
}

function applyManualOverrides(extracted, manualOverrides) {
  if (!manualOverrides) {
    return extracted;
  }

  const overrideFields = [
    "rfcEmisor",
    "folio",
    "ticketId",
    "codigoFacturacion",
    "fecha",
    "monto",
    "permisoCre",
    "estacionCodigo",
    "estacionNombre",
    "sucursal",
    "serie",
    "token",
    "terminal",
    "webId",
    "businessDomain",
    "ocrText",
    "ocrTextPreview",
  ];
  const next = {
    ...extracted,
    ocrCandidates: {
      ...(extracted.ocrCandidates ?? {}),
      ...(manualOverrides.ocrCandidates ?? {}),
    },
    manualOverridesApplied: true,
  };

  for (const field of overrideFields) {
    if (!isMissing(manualOverrides[field])) {
      next[field] = manualOverrides[field];
      if (
        [
          "ticketId",
          "codigoFacturacion",
          "permisoCre",
          "estacionCodigo",
          "estacionNombre",
          "sucursal",
          "serie",
          "token",
          "terminal",
          "webId",
        ].includes(field)
      ) {
        next.ocrCandidates[field] = manualOverrides[field];
      }
    }
  }

  return next;
}

function applyOcrConfirmationToReview(ocrReview, job, extracted) {
  if (isAutonomousBillingJob(job) && isAutonomousOcrAccepted(extracted)) {
    return {
      ...ocrReview,
      ready: true,
      requiresUserAction: false,
      reviewMode: "autonomous_candidate_resolution",
      userConfirmed: false,
      reason: "ocr_autonomous_resolved",
      statusMessage: "OCR resuelto automaticamente con candidatos validados",
    };
  }

  const confirmed =
    job?.ocrReviewConfirmed === true ||
    job?.ocrReview?.status === "confirmed" ||
    job?.ocrReview?.confirmed === true;

  if (!confirmed || !ocrReview?.requiresUserAction) {
    return ocrReview;
  }

  const hardFields = new Set(["rfcEmisor", "fecha", "monto"]);
  const unresolvedHardFields = (ocrReview.missingTicketFields ?? []).filter((issue) => {
    const field = issue.field ?? issue.name ?? issue.key;

    if (!hardFields.has(field)) {
      return false;
    }

    const value = extracted?.[field] ?? extracted?.ocrCandidates?.[field];

    return isMissing(value);
  });

  return {
    ...ocrReview,
    ready: unresolvedHardFields.length === 0,
    requiresUserAction: unresolvedHardFields.length > 0,
    reviewMode: "validated_after_user_confirmation",
    userConfirmed: true,
    missingTicketFields: unresolvedHardFields,
    statusMessage: unresolvedHardFields.length
      ? "No se pudieron extraer RFC, fecha o monto del ticket; revisa esos datos antes de continuar"
      : "OCR confirmado por el usuario",
  };
}

function buildCompletedMessage(extracted) {
  if (extracted.ocrEngine === "google_vision") {
    return "Factura generada correctamente con OCR real";
  }

  if (extracted.sourceType === "storage_image") {
    return "Factura generada correctamente con OCR mock desde foto";
  }

  return "Factura generada correctamente";
}

function buildExtractionPatch(extracted, job = {}) {
  return {
    ...extracted,
    ocrCheckpoint: buildOcrCheckpoint({ job, extracted }),
    extractedData: {
      rfcEmisor: extracted.rfcEmisor ?? null,
      folio: extracted.folio ?? null,
      ticketId: extracted.ticketId ?? extracted.ocrCandidates?.ticketId ?? null,
      codigoFacturacion: extracted.codigoFacturacion ?? extracted.ocrCandidates?.codigoFacturacion ?? null,
      fecha: extracted.fecha ?? null,
      monto: extracted.monto ?? null,
      permisoCre: extracted.permisoCre ?? null,
      estacionCodigo: extracted.estacionCodigo ?? null,
      estacionNombre: extracted.estacionNombre ?? null,
      sucursal: extracted.sucursal ?? extracted.ocrCandidates?.sucursal ?? null,
      serie: extracted.serie ?? extracted.ocrCandidates?.serie ?? null,
      token: extracted.token ?? extracted.ocrCandidates?.token ?? null,
      terminal: extracted.terminal ?? extracted.ocrCandidates?.terminal ?? null,
      webId: extracted.webId ?? extracted.ocrCandidates?.webId ?? null,
      businessDomain: extracted.businessDomain ?? null,
      ocrEngine: extracted.ocrEngine ?? null,
      ocrConfidence: extracted.ocrConfidence ?? null,
      ocrCandidates: extracted.ocrCandidates ?? null,
      ticketEnrichment: extracted.ticketEnrichment ?? null,
      ocrResolution: extracted.ocrResolution ?? null,
      portalDiscovery: extracted.portalDiscovery ?? null,
      manualOverridesApplied: extracted.manualOverridesApplied ?? false,
    },
  };
}

function buildAutonomousOcrFailureResult({ extractionPatch, portalCandidatePatch, extracted }) {
  const unresolvedFields = extracted.ocrResolution?.unresolvedFields ?? [];
  return {
    ...extractionPatch,
    ...portalCandidatePatch,
    status: "failed",
    workflowStage: "complete",
    statusMessage: "No fue posible leer con seguridad los datos indispensables del ticket",
    reason: "ocr_unresolved",
    error: {
      code: "ocr_unresolved",
      message: `Campos sin resolver: ${unresolvedFields.join(", ") || "datos indispensables"}`,
      retryable: false,
    },
  };
}

function isMissing(value) {
  if (value === null || value === undefined) {
    return true;
  }

  return typeof value === "string" && value.trim() === "";
}

export function inferPortalDetails({ rfcEmisor, portalUrl, ocrCandidates } = {}) {
  // 1. Try to map RFC to name
  const rfc = String(rfcEmisor ?? "").trim().toUpperCase();
  const rfcMap = {
    'CCO8605231N4': 'OXXO',
    'SEM980701STA': '7-Eleven',
    'NWM9709244W4': 'Walmart',
    'TSO991022PB6': 'Soriana',
    'TCH850701RM1': 'Chedraui',
    'CME910715UB9': 'Costco',
    'CSI020226MV4': 'Starbucks',
    'OVI800131GQ6': 'Vips',
    'OFA9210138U1': "Domino's / Burger King",
    'RAD161031RK1': "McDonald's",
    'RTO840921RE4': 'Toks',
    'SHE190630V37': 'Sanborns',
    'SGM950714DC2': 'Oxxo Gas',
    'PET040903DH1': 'Petro Seven',
    'BES160503J91': 'BP México',
    'CME821025G96': 'Shell',
    'HPL970402EV7': 'Hidrosina',
    'CFC110121742': 'Farmacias del Ahorro',
    'FGU830930PD3': 'Farmacias Guadalajara',
    'FBE9110215Z3': 'Farmacias Benavides',
    'FSI970908ML5': 'Farmacias de Similares',
    'PPL961114GZ1': 'Farmacia San Pablo',
    'DLI931201MI9': 'Liverpool',
    'COP920428Q20': 'Coppel',
    'PHI830429MG6': 'El Palacio de Hierro',
    'SUB910603SB3': 'Suburbia',
    'SOM101125UEA': 'Sears',
    'ODM950324V2A': 'Office Depot',
    'HDM001017AS1': 'The Home Depot',
    'AME970109GW0': 'AutoZone',
    'MAS121116E51': 'Petco',
    'OCI970818KX9': 'Cinemex',
    'TCI121023F10': 'Cinépolis',
    'TME840315KT6': 'Telmex',
    'CSS160330CP7': 'CFE',
    'ADO700918J39': 'ADO',
    'CVA041027H80': 'Volaris',
    'AME880912I89': 'Aeroméxico',
    'ANA050518RL1': 'Viva Aerobus',
    'CCC050606EA6': 'Circle K',
    'TTB040915CY9': 'Tiendas 3B',
    'CCF121101KQ4': 'La Comer / Fresko',
    'ECE9610253TA': 'Elektra',
    'FAR970429SE2': 'Farmacias Yza',
    'ANE140618P37': 'Amazon México',
    'MLE981244779': 'Mercado Libre',
    'RDI841003QJ4': 'Telcel',
    'ACO151023U11': 'AT&T México',
    'ECB121102B78': 'Izzi',
    'TPT890516JP5': 'Totalplay',
    'MEG920701ID8': 'Megacable',
    'SIH951120286': 'HEB México',
    'CDM840307UP1': 'Laboratorio Médico del Chopo',
    'SDG030403AM7': 'Salud Digna',
    'PRB100802H20': 'KFC México',
    'LGA0111296B6': 'Librerías Gandhi',
    'PMU940317114': 'iShop Mixup',
    'EME880309SK5': 'Estafeta',
    'DEM8801152E9': 'DHL',
    'HER170522M19': 'IKEA México',
    'CSD161207R2A': 'Sodimac',
    'ADD150727S34': 'Decathlon',
    'CPF6307036N8': 'Tag IAVE',
    'OOM960429832': 'OfficeMax',
    'ISP831021NV9': 'Innova Sport',
    'ZMC960601538': 'Zara',
    'CME961203360': 'C&A',
    'CLE810525EA1': 'Casa Ley',
    'CDE8401046V6': 'Calimax',
    'COP060201DL4': 'Little Caesars',
    'EST850628K51': 'Steren',
    'MME160812J15': 'Miniso',
    'HAM111006K69': 'H&M',
    'AEB620401831': 'Estrella Blanca',
    'GFA471204859': 'Flecha Amarilla',
    'OCS120223SN2': 'Tierra Garat',
    'ALU830902ST6': 'Alpura',
    'CSU070301MK3': 'Subway',
    'TAQO351266033': 'Flecha Roja',
    'TAQO351271383': 'Flecha Roja',
  };

  if (rfc && rfcMap[rfc]) {
    return {
      portalName: rfcMap[rfc],
      businessDomain: rfc.toLowerCase()
    };
  }

  // 2. Try to infer from URLs
  const urls = [];
  if (portalUrl) urls.push(portalUrl);
  if (ocrCandidates?.portalUrls) {
    const list = Array.isArray(ocrCandidates.portalUrls) ? ocrCandidates.portalUrls : [ocrCandidates.portalUrls];
    for (const u of list) {
      if (u) urls.push(String(u));
    }
  }

  for (const url of urls) {
    const lowered = url.toLowerCase();

    // Alsea brands
    if (lowered.includes('alsea.interfactura.com') || lowered.includes('alseadonativos.interfactura.com')) {
      if (lowered.includes('opc=starbucks')) return { portalName: 'Starbucks', businessDomain: 'starbucks.com.mx' };
      if (lowered.includes('opc=dominos')) return { portalName: "Domino's", businessDomain: 'dominos.com.mx' };
      if (lowered.includes('opc=burgerking')) return { portalName: 'Burger King', businessDomain: 'burgerking.com.mx' };
      if (lowered.includes('opc=chilis')) return { portalName: "Chili's", businessDomain: 'chilis.com.mx' };
      if (lowered.includes('opc=pfc')) return { portalName: "P.F. Chang's", businessDomain: 'pfchangs.com.mx' };
      if (lowered.includes('opc=ccf')) return { portalName: 'The Cheesecake Factory', businessDomain: 'thecheesecakefactory.com.mx' };
      if (lowered.includes('opc=italiannis')) return { portalName: "Italianni's", businessDomain: 'italiannis.com.mx' };
      if (lowered.includes('opc=vips')) return { portalName: 'Vips', businessDomain: 'vips.com.mx' };
      return { portalName: 'Alsea', businessDomain: 'alsea.com.mx' };
    }

    // generic substring checks
    if (lowered.includes('7-eleven') || lowered.includes('e7-eleven')) return { portalName: '7-Eleven', businessDomain: '7-eleven.com.mx' };
    if (lowered.includes('oxxo')) return { portalName: 'OXXO', businessDomain: 'oxxo.com' };
    if (lowered.includes('walmart')) return { portalName: 'Walmart', businessDomain: 'walmartmexico.com.mx' };
    if (lowered.includes('soriana')) return { portalName: 'Soriana', businessDomain: 'soriana.com' };
    if (lowered.includes('chedraui')) return { portalName: 'Chedraui', businessDomain: 'chedraui.com.mx' };
    if (lowered.includes('costco')) return { portalName: 'Costco', businessDomain: 'costco.com.mx' };
    if (lowered.includes('mcdonalds')) return { portalName: "McDonald's", businessDomain: 'mcdonalds.com.mx' };
    if (lowered.includes('toks')) return { portalName: 'Toks', businessDomain: 'toks.com.mx' };
    if (lowered.includes('sanborns')) return { portalName: 'Sanborns', businessDomain: 'sanborns.com.mx' };
    if (lowered.includes('petroseven') || lowered.includes('petro-7')) return { portalName: 'Petro Seven', businessDomain: 'petroseven.com.mx' };
    if (lowered.includes('bp.com') || lowered.includes('bp.mx')) return { portalName: 'BP México', businessDomain: 'bp.com' };
    if (lowered.includes('shell')) return { portalName: 'Shell', businessDomain: 'shell.com.mx' };
    if (lowered.includes('hidrosina')) return { portalName: 'Hidrosina', businessDomain: 'hidrosina.com.mx' };
    if (lowered.includes('ahorro')) return { portalName: 'Farmacias del Ahorro', businessDomain: 'ahorro.com.mx' };
    if (lowered.includes('guadalajara') || lowered.includes('fragua')) return { portalName: 'Farmacias Guadalajara', businessDomain: 'farmaciasguadalajara.com.mx' };
    if (lowered.includes('benavides')) return { portalName: 'Farmacias Benavides', businessDomain: 'benavides.com.mx' };
    if (lowered.includes('similares')) return { portalName: 'Farmacias de Similares', businessDomain: 'farmaciasdesimilares.com' };
    if (lowered.includes('sanpablo')) return { portalName: 'Farmacia San Pablo', businessDomain: 'farmaciasanpablo.com.mx' };
    if (lowered.includes('liverpool')) return { portalName: 'Liverpool', businessDomain: 'liverpool.com.mx' };
    if (lowered.includes('coppel')) return { portalName: 'Coppel', businessDomain: 'coppel.com' };
    if (lowered.includes('palaciodehierro')) return { portalName: 'El Palacio de Hierro', businessDomain: 'elpalaciodehierro.com' };
    if (lowered.includes('suburbia')) return { portalName: 'Suburbia', businessDomain: 'suburbia.com.mx' };
    if (lowered.includes('sears')) return { portalName: 'Sears', businessDomain: 'sears.com.mx' };
    if (lowered.includes('officedepot')) return { portalName: 'Office Depot', businessDomain: 'officedepot.com.mx' };
    if (lowered.includes('homedepot')) return { portalName: 'The Home Depot', businessDomain: 'homedepot.com.mx' };
    if (lowered.includes('autozone')) return { portalName: 'AutoZone', businessDomain: 'autozone.com.mx' };
    if (lowered.includes('petco')) return { portalName: 'Petco', businessDomain: 'petco.com.mx' };
    if (lowered.includes('cinemex')) return { portalName: 'Cinemex', businessDomain: 'cinemex.com' };
    if (lowered.includes('cinepolis')) return { portalName: 'Cinépolis', businessDomain: 'cinepolis.com' };
    if (lowered.includes('telmex')) return { portalName: 'Telmex', businessDomain: 'telmex.com' };
    if (lowered.includes('cfe')) return { portalName: 'CFE', businessDomain: 'cfe.mx' };
    if (lowered.includes('aeromexico')) return { portalName: 'Aeroméxico', businessDomain: 'aeromexico.com' };
    if (lowered.includes('volaris')) return { portalName: 'Volaris', businessDomain: 'volaris.com' };
    if (lowered.includes('vivaaerobus')) return { portalName: 'Viva Aerobus', businessDomain: 'vivaaerobus.com' };
    if (lowered.includes('circlek')) return { portalName: 'Circle K', businessDomain: 'circlek.com.mx' };
    if (lowered.includes('tiendas3b') || lowered.includes('3b')) return { portalName: 'Tiendas 3B', businessDomain: 'tiendas3b.com' };
    if (lowered.includes('lacomer') || lowered.includes('fresko')) return { portalName: 'La Comer / Fresko', businessDomain: 'lacomer.com.mx' };
    if (lowered.includes('elektra')) return { portalName: 'Elektra', businessDomain: 'elektra.mx' };
    if (lowered.includes('farmaciasyza') || lowered.includes('yza')) return { portalName: 'Farmacias Yza', businessDomain: 'yza.mx' };
    if (lowered.includes('amazon')) return { portalName: 'Amazon México', businessDomain: 'amazon.com.mx' };
    if (lowered.includes('mercadolibre')) return { portalName: 'Mercado Libre', businessDomain: 'mercadolibre.com.mx' };
    if (lowered.includes('telcel')) return { portalName: 'Telcel', businessDomain: 'telcel.com' };
    if (lowered.includes('att')) return { portalName: 'AT&T México', businessDomain: 'att.com.mx' };
    if (lowered.includes('izzi')) return { portalName: 'Izzi', businessDomain: 'izzi.mx' };
    if (lowered.includes('totalplay')) return { portalName: 'Totalplay', businessDomain: 'totalplay.com.mx' };
    if (lowered.includes('megacable')) return { portalName: 'Megacable', businessDomain: 'megacable.com.mx' };
    if (lowered.includes('heb')) return { portalName: 'HEB México', businessDomain: 'heb.com.mx' };
    if (lowered.includes('chopo')) return { portalName: 'Laboratorio Médico del Chopo', businessDomain: 'chopo.com.mx' };
    if (lowered.includes('salud-digna') || lowered.includes('saluddigna')) return { portalName: 'Salud Digna', businessDomain: 'salud-digna.org' };
    if (lowered.includes('kfc')) return { portalName: 'KFC México', businessDomain: 'kfc.com.mx' };
    if (lowered.includes('gandhi')) return { portalName: 'Librerías Gandhi', businessDomain: 'gandhi.com.mx' };
    if (lowered.includes('mixup') || lowered.includes('ishop')) return { portalName: 'iShop Mixup', businessDomain: 'mixup.com' };
    if (lowered.includes('estafeta')) return { portalName: 'Estafeta', businessDomain: 'estafeta.com' };
    if (lowered.includes('dhl')) return { portalName: 'DHL', businessDomain: 'dhl.com' };
    if (lowered.includes('ikea')) return { portalName: 'IKEA México', businessDomain: 'ikea.com' };
    if (lowered.includes('sodimac')) return { portalName: 'Sodimac', businessDomain: 'sodimac.com.mx' };
    if (lowered.includes('decathlon')) return { portalName: 'Decathlon', businessDomain: 'decathlon.com.mx' };
    if (lowered.includes('officemax')) return { portalName: 'OfficeMax', businessDomain: 'officemax.com.mx' };
    if (lowered.includes('innovasport')) return { portalName: 'Innova Sport', businessDomain: 'innovasport.com' };
    if (lowered.includes('zara')) return { portalName: 'Zara', businessDomain: 'zara.com' };
    if (lowered.includes('cya') || lowered.includes('c&a')) return { portalName: 'C&A', businessDomain: 'cyamoda.com' };
    if (lowered.includes('casaley')) return { portalName: 'Casa Ley', businessDomain: 'casaley.com.mx' };
    if (lowered.includes('calimax')) return { portalName: 'Calimax', businessDomain: 'calimax.com.mx' };
    if (lowered.includes('littlecaesars')) return { portalName: 'Little Caesars', businessDomain: 'littlecaesars.com.mx' };
    if (lowered.includes('steren')) return { portalName: 'Steren', businessDomain: 'steren.com.mx' };
    if (lowered.includes('miniso')) return { portalName: 'Miniso', businessDomain: 'miniso.com.mx' };
    if (lowered.includes('hm.com')) return { portalName: 'H&M', businessDomain: 'hm.com' };
    if (lowered.includes('estrellablanca')) return { portalName: 'Estrella Blanca', businessDomain: 'estrellablanca.com.mx' };
    if (lowered.includes('flechaamarilla')) return { portalName: 'Flecha Amarilla', businessDomain: 'flechaamarilla.com.mx' };
    if (lowered.includes('tierragarat') || lowered.includes('garat')) return { portalName: 'Tierra Garat', businessDomain: 'tierragarat.com.mx' };
    if (lowered.includes('alpura')) return { portalName: 'Alpura', businessDomain: 'alpura.com.mx' };
    if (lowered.includes('subway')) return { portalName: 'Subway', businessDomain: 'subway.com.mx' };
    if (lowered.includes('flecharoja')) return { portalName: 'Flecha Roja', businessDomain: 'flecharoja.com.mx' };
  }

  // 3. Try to use OCR extracted name if it's valid
  if (ocrCandidates?.emisorNombre) {
    const name = String(ocrCandidates.emisorNombre).trim();
    if (name && name.toLowerCase() !== 'xxxx' && name.toLowerCase() !== 'xxx') {
      return {
        portalName: name,
        businessDomain: null
      };
    }
  }

  return null;
}
