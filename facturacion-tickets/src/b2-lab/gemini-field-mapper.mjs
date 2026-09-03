import { getAiGeminiRequestTimeoutMs } from "../config/env.mjs";
import { createGeminiClient } from "../shared/gemini-client.mjs";

export async function generateB2FieldPlan({
  pageState,
  ticket,
  taxProfile,
  fiscalCompliance,
  goal,
  attempt,
  previousErrors = [],
  flowState = "filling_ticket",
  learningNotes = null,
}) {
  return generateB2Plan({
    mode: "map",
    pageState,
    ticket,
    taxProfile,
    fiscalCompliance,
    goal,
    attempt,
    previousErrors,
    flowState,
    learningNotes,
  });
}

export async function generateB2DiagnosticPlan({
  pageState,
  ticket,
  taxProfile,
  fiscalCompliance,
  goal,
  attempt,
  previousErrors = [],
  flowState = "filling_ticket",
  validationIssues = [],
  failedActions = [],
  learningNotes = null,
}) {
  return generateB2Plan({
    mode: "diagnose",
    pageState,
    ticket,
    taxProfile,
    fiscalCompliance,
    goal,
    attempt,
    previousErrors,
    flowState,
    validationIssues,
    failedActions,
    learningNotes,
  });
}

async function generateB2Plan({
  mode,
  pageState,
  ticket,
  taxProfile,
  fiscalCompliance,
  goal,
  attempt,
  previousErrors = [],
  flowState = "filling_ticket",
  validationIssues = [],
  failedActions = [],
  learningNotes = null,
}) {
  const provider = createGeminiClient();

  if (!provider.client) {
    return {
      status: "cannot_solve",
      confidence: 0,
      reason: provider.backend === "vertex"
        ? "Vertex AI no tiene proyecto o ubicacion configurados"
        : "GEMINI_API_KEY no configurada",
      actions: [],
    };
  }

  const prompt = buildPrompt({
    mode,
    pageState,
    ticket,
    taxProfile,
    fiscalCompliance,
    goal,
    attempt,
    previousErrors,
    flowState,
    validationIssues,
    failedActions,
    learningNotes,
  });
  const models = getB2GeminiModelChain();
  const failures = [];
  let lastPlan = null;

  for (const model of models) {
    const ai = provider.client;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), getAiGeminiRequestTimeoutMs());

    try {
      const response = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          temperature: 0,
          responseMimeType: "application/json",
          thinkingConfig: {
            thinkingBudget: Number(process.env.B2_GEMINI_THINKING_BUDGET ?? 0),
          },
          abortSignal: abortController.signal,
        },
      });

      const plan = {
        ...normalizePlan(JSON.parse(response.text)),
        providerModel: model,
        providerFallbacks: failures,
      };

      if (shouldEscalatePlan(plan, model, models)) {
        lastPlan = plan;
        failures.push({
          model,
          error: plan.reason,
          providerError: `b2_plan_${plan.status}`,
          retryable: true,
        });
        continue;
      }

      return plan;
    } catch (error) {
      failures.push({
        model,
        error: error.message,
        providerError: error.status ?? error.name ?? "gemini_error",
        retryable: error.name === "AbortError" || error.status === 429 || error.status >= 500,
      });

      if (!shouldTryNextModel(error, model, models)) {
        break;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  if (lastPlan) {
    return {
      ...lastPlan,
      providerFallbacks: failures,
    };
  }

  const lastFailure = failures.at(-1);
  return {
    status: "cannot_solve",
    confidence: 0,
    reason: `Gemini B2 fallo: ${lastFailure?.error ?? "sin respuesta"}`,
    actions: [],
    providerModel: lastFailure?.model ?? models.at(-1) ?? null,
    providerError: lastFailure?.providerError ?? "gemini_error",
    providerFallbacks: failures,
    retryable: failures.some((failure) => failure.retryable),
  };
}

function getB2GeminiModelChain() {
  const configured =
    process.env.B2_GEMINI_MODEL_CHAIN ??
    process.env.B2_GEMINI_MODEL ??
    process.env.AI_GEMINI_MODEL ??
    "gemini-3.1-flash-lite";

  return String(configured)
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
}

function shouldTryNextModel(error, currentModel, models) {
  const currentIndex = models.indexOf(currentModel);
  const hasNext = currentIndex >= 0 && currentIndex < models.length - 1;

  if (!hasNext) {
    return false;
  }

  return error.name === "AbortError" || error.status === 429 || error.status >= 500 || error.status === 404;
}

function shouldEscalatePlan(plan, currentModel, models) {
  const currentIndex = models.indexOf(currentModel);
  const hasNext = currentIndex >= 0 && currentIndex < models.length - 1;

  if (!hasNext) {
    return false;
  }

  if (plan.status === "cannot_solve") {
    return true;
  }

  return plan.status === "blocked" && Number(plan.confidence ?? 0) < 0.9;
}

function buildPrompt({
  mode,
  pageState,
  ticket,
  taxProfile,
  fiscalCompliance,
  goal,
  attempt,
  previousErrors,
  flowState,
  validationIssues,
  failedActions,
  learningNotes,
}) {
  return JSON.stringify(
    {
      role:
        "You are a deterministic mapper/diagnostician for Mexican CFDI portals. You do not browse freely. You inspect the provided visible DOM state and return only safe JSON actions for the runner to validate.",
      mode,
      hardRules: [
        "Return valid JSON only.",
        "Use only selectors present in pageState.",
        "Only fill inputs/selects that are present in pageState.inputs/pageState.selects; those are editable controls. Never target disabled/read-only controls.",
        "For pageState.selects entries with kind custom_select, return a select action; the executor will open the dropdown and choose the matching option.",
        "Never click final invoice emission buttons yourself. The runner will click final submit only after semantic validation passes.",
        "Do not treat a visible or enabled Facturar/Generar Factura button as success. Success requires XML/PDF download controls or downloaded files.",
        "Do not invent values. Use only valueKey or literal values from ticket/taxProfile/fiscalCompliance.",
        "Fill every visible required ticket/customer field before clicking continue/search/validate.",
        "If a field says Codigo de facturacion, Codigo unico, Codigo Fact, or similar, use ticket.codigoFacturacion. Never use ticket.folio for that field.",
        "If a field says Folio, use ticket.folio or ticket.folioVenta, but only if it does not say Codigo.",
        "If a field says ID de venta, use ticket.idVenta or ticket.tc.",
        "If a field says Membresia o RFC, RFC, RFC receptor, cliente, comprador, or RFCReceptor, use taxProfile.rfc unless the page explicitly asks for emitter RFC.",
        "Use ticket.rfcEmisor only when the field explicitly says RFC emisor, emisor RFC, or empresa emisora.",
        "If a field says Codigo postal or CP, use taxProfile.postalCode.",
        "If a field says Sucursal, branch, tienda, or Num. Sucursal, use ticket.sucursal.",
        "If a field id/name/label contains Fecha, date, dtticket, or dateInput, use ticket.fecha. Never use ticket.tc, ticket.ticketId, ticket.codigoFacturacion, or folio for date fields.",
        "If a field says Numero de ticket, TC, ticket, folio, use ticket.tc first, then ticket.ticketId.",
        "If a field says Serie, use ticket.serie.",
        "If a field says Token, use ticket.token.",
        "If a field says Transaccion, # Transaccion, TR, use ticket.tr.",
        "If a field says total or importe, use ticket.monto.",
        "If a field asks fiscal regime, use fiscalCompliance.expectedFiscalRegime.code.",
        "If a field asks uso CFDI, use fiscalCompliance.expectedCfdiUse.code.",
        "If Correo/email is filled and a Guardar Correo button is visible, click Guardar Correo before trying Buscar or final invoice readiness.",
        "If a modal/alert/overlay blocks the page and has Aceptar/Cerrar/Continuar, click that first only if it is informational.",
        "When a portal uses image buttons, prefer controls whose id/name contains Buscar, Validar, Continuar, Siguiente, or btnBuscar over nearby tooltip/help anchors.",
        "If a modal asks whether fiscal data is correct, prefer Continuar/Aceptar confirmation over Cerrar, unless the data is visibly wrong.",
        "If a button is disabled, inspect missing/invalid fields instead of clicking it.",
        "Use pageState.pageClassification as the current portal state. If it says portal_landing, follow invoice entrypoint links/buttons. If it says login_with_express_path, choose Factura Express or equivalent, not the login fields. If it says technical_block, return blocked and do not retry the same URL/action.",
        "For pages with external portal links, prefer the visible entrypoint that says Ir al Portal de Facturacion, Factura aqui, Factura Express, or Obtener factura.",
        "If a technical block appears after clicking an entrypoint, report it as blocked with the detected signal. Do not keep clicking login or menu controls.",
        "If the previous action failed, do not repeat it unchanged; choose a different action or explain why blocked.",
        "If mode is diagnose, explain the likely cause in reason and return a repair plan that directly addresses validationIssues/failedActions.",
        "After clicking a confirmation button, wait for the next page state; do not repeat filling fields that are already filled.",
        "If the portal says the ticket was already validated, already invoiced, previously invoiced, or a comprobante was already generated, stop with blocked/cannot_solve. Do not navigate to reprint/recover/download for that ticket.",
      ],
      outputSchema: {
        status: "continue|ready_for_final_submit|cannot_solve|blocked",
        confidence: "number 0..1",
        reason: "short Spanish reason",
        actions: [
          {
            type: "fill|setValue|datePicker|select|click|downloadCfdi|stop",
            selector: "exact selector from pageState",
            valueKey:
              "ticket.codigoFacturacion|ticket.folio|ticket.folioVenta|ticket.idVenta|ticket.tc|ticket.tr|ticket.ticketId|ticket.monto|ticket.fecha|ticket.rfcEmisor|ticket.sucursal|ticket.serie|ticket.token|taxProfile.rfc|taxProfile.postalCode|taxProfile.email|fiscalCompliance.expectedFiscalRegime.code|fiscalCompliance.expectedCfdiUse.code",
            value: "only if no valueKey exists",
            inputStrategy: "auto|fill|type|setValue|datePicker|select",
            xmlSelector: "only for downloadCfdi",
            pdfSelector: "only for downloadCfdi",
            reason: "short reason",
          },
        ],
      },
      goal,
      attempt,
      flowState,
      previousErrors,
      validationIssues,
      failedActions,
      learningNotes,
      ticket,
      taxProfile: {
        rfc: taxProfile?.rfc,
        legalName: taxProfile?.legalName,
        postalCode: taxProfile?.postalCode,
        email: taxProfile?.email,
        fiscalRegime: taxProfile?.fiscalRegime,
        cfdiUse: taxProfile?.cfdiUse,
      },
      fiscalCompliance,
      pageState,
    },
    null,
    2,
  );
}

function normalizePlan(plan) {
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];

  return {
    status: typeof plan?.status === "string" ? plan.status : "cannot_solve",
    confidence: Number.isFinite(plan?.confidence) ? Math.max(0, Math.min(1, plan.confidence)) : 0,
      reason: typeof plan?.reason === "string" ? plan.reason : "Plan B2 sin razon",
      actions: actions.slice(0, 12).map((action) => ({
        type: action?.type,
        selector: action?.selector,
        valueKey: action?.valueKey,
        value: action?.value,
        inputStrategy: action?.inputStrategy,
        xmlSelector: action?.xmlSelector,
        pdfSelector: action?.pdfSelector,
        reason: action?.reason ?? null,
      })),
  };
}
