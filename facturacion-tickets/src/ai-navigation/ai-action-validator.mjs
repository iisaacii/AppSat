import { getAiNavigatorMaxActions, isAiFinalSubmitEnabled } from "../config/env.mjs";
import { formatValue, isSupportedValueFormat } from "../shared/value-formatters.mjs";

const allowedActionTypes = new Set([
  "intent",
  "waitForSelector",
  "fill",
  "setValue",
  "select",
  "check",
  "click",
  "clickText",
  "waitForLoadState",
  "screenshot",
  "finalSubmit",
  "downloadCfdi",
  "stop",
]);

const selectorActionTypes = new Set([
  "waitForSelector",
  "fill",
  "setValue",
  "select",
  "check",
  "click",
  "finalSubmit",
]);

const valueActionTypes = new Set(["fill", "setValue", "select"]);
const allowedValueKeyPrefixes = ["ticket.", "taxProfile.", "fiscalCompliance.", "context."];
const dangerousClickText = /generar\s+factura|emitir|timbrar|confirmar|finalizar|enviar\s+factura/i;
const dangerousIntent = /generar\s*factura|emitir|timbrar|finalizar|enviar\s*factura/i;
const finalSubmitText = /facturar|generar\s+factura|emitir|timbrar|finalizar|enviar\s+factura/i;
const nonFinalStepText = /buscar|validar|consultar|guardar\s+correo|continuar|siguiente|aceptar/i;
const allowedIntents = new Set([
  "fillVisibleFields",
  "search",
  "validate",
  "continue",
  "next",
  "save",
  "addClient",
  "confirmModal",
  "accept",
  "selectPersonType",
  "downloadCfdi",
]);

export function validateAiActionPlan(plan, { job, context }) {
  const errors = [];
  const normalizedPlan = applyPlanInferences(plan);
  const actions = Array.isArray(normalizedPlan?.actions) ? normalizedPlan.actions : [];
  const finalSubmitGuard = buildAiFinalSubmitGuard(job);

  if (!normalizedPlan || typeof normalizedPlan !== "object") {
    return { ok: false, errors: ["plan must be an object"], actions: [], finalSubmitGuard };
  }

  if (typeof normalizedPlan.status !== "string") {
    errors.push("status must be a string");
  }

  if (typeof normalizedPlan.confidence !== "number" || normalizedPlan.confidence < 0 || normalizedPlan.confidence > 1) {
    errors.push("confidence must be a number between 0 and 1");
  }

  if (actions.length > getAiNavigatorMaxActions()) {
    errors.push(`actions exceed max ${getAiNavigatorMaxActions()}`);
  }

  const sanitizedActions = [];

  actions.forEach((action, index) => {
    const prefix = `actions[${index}]`;
    const normalizedAction = applyActionInferences(action);

    if (!allowedActionTypes.has(normalizedAction.type)) {
      errors.push(`${prefix}.type unsupported: ${normalizedAction.type}`);
      return;
    }

    if (normalizedAction.type === "intent") {
      if (isMissing(normalizedAction.intent)) {
        errors.push(`${prefix}.intent is required`);
      } else if (!allowedIntents.has(normalizedAction.intent)) {
        errors.push(`${prefix}.intent unsupported: ${normalizedAction.intent}`);
      }

      if (dangerousIntent.test(normalizedAction.intent) || dangerousIntent.test(normalizedAction.reason ?? "")) {
        errors.push(`${prefix}.intent looks like final submit; use finalSubmit action`);
      }
    }

    if (selectorActionTypes.has(normalizedAction.type) && isMissing(normalizedAction.selector)) {
      errors.push(`${prefix}.selector is required`);
    }

    if (normalizedAction.type === "clickText") {
      const hasText = !isMissing(normalizedAction.text);
      const hasValueKey = !isMissing(normalizedAction.valueKey);

      if (!hasText && !hasValueKey) {
        errors.push(`${prefix}.text or valueKey is required`);
      }

      if (hasValueKey && !allowedValueKeyPrefixes.some((prefixValue) => normalizedAction.valueKey.startsWith(prefixValue))) {
        errors.push(`${prefix}.valueKey is not allowed: ${normalizedAction.valueKey}`);
      }

      if (normalizedAction.format && !isSupportedValueFormat(normalizedAction.format)) {
        errors.push(`${prefix}.format is not supported: ${normalizedAction.format}`);
      }
    }

    if (valueActionTypes.has(normalizedAction.type)) {
      const hasValueKey = !isMissing(normalizedAction.valueKey);
      const hasLiteralValue = !isMissing(normalizedAction.value);

      if (!hasValueKey && !hasLiteralValue) {
        errors.push(`${prefix}.valueKey or value is required`);
      }

      if (hasValueKey && !allowedValueKeyPrefixes.some((prefixValue) => normalizedAction.valueKey.startsWith(prefixValue))) {
        errors.push(`${prefix}.valueKey is not allowed: ${normalizedAction.valueKey}`);
      }

      if (normalizedAction.format && !isSupportedValueFormat(normalizedAction.format)) {
        errors.push(`${prefix}.format is not supported: ${normalizedAction.format}`);
      }
    }

    if (normalizedAction.type === "downloadCfdi" && (isMissing(normalizedAction.xmlSelector) || isMissing(normalizedAction.pdfSelector))) {
      errors.push(`${prefix}.xmlSelector and pdfSelector are required`);
    }

    if (normalizedAction.type === "clickText" && dangerousClickText.test(normalizedAction.text ?? "")) {
      errors.push(`${prefix}.text looks like final submit; use finalSubmit action`);
    }

    if (normalizedAction.type === "click" && dangerousClickText.test(normalizedAction.reason ?? "")) {
      errors.push(`${prefix}.reason looks like final submit; use finalSubmit action`);
    }

    if (normalizedAction.type === "finalSubmit" && !finalSubmitGuard.ready) {
      errors.push(`${prefix}.finalSubmit blocked: ${finalSubmitGuard.blockedBy.join(", ")}`);
    }

    sanitizedActions.push({
      ...normalizedAction,
      intent: normalizedAction.intent ?? null,
      selector: normalizeAiSelector(normalizedAction.selector),
      xmlSelector: normalizeAiSelector(normalizedAction.xmlSelector),
      pdfSelector: normalizeAiSelector(normalizedAction.pdfSelector),
      timeoutMs: normalizeTimeout(normalizedAction.timeoutMs),
      exact: normalizedAction.exact === true,
    });
  });

  return {
    ok: errors.length === 0,
    errors,
    actions: sanitizedActions,
    finalSubmitGuard,
    contextKeys: Object.keys(context ?? {}),
  };
}

export function buildAiFinalSubmitGuard(job) {
  const checks = {
    workerAllowsAiFinalSubmit: isAiFinalSubmitEnabled(),
    jobApprovedFinalSubmit: job.portalFinalSubmitApproved === true,
  };
  const blockedBy = [];

  if (!checks.workerAllowsAiFinalSubmit) blockedBy.push("ai_worker_allow_submit_false");
  if (!checks.jobApprovedFinalSubmit) blockedBy.push("job_final_submit_not_approved");

  return {
    ready: blockedBy.length === 0,
    blockedBy,
    ...checks,
  };
}

export function readAiValue(action, valueSource) {
  const rawValue = !isMissing(action.value) ? action.value : readPath(valueSource, action.valueKey);
  return formatValue(rawValue, action.format);
}

function readPath(source, path) {
  if (!path) {
    return undefined;
  }

  return path.split(".").reduce((current, key) => current?.[key], source);
}

function normalizeTimeout(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(number, 30000) : 10000;
}

function normalizeAiSelector(value) {
  if (isMissing(value)) {
    return value;
  }

  return escapeUnescapedIdColon(String(value)
    .replace(/\\\\:/g, "\\:")
    .replace(/\\\\\./g, "\\.")
    .replace(/\\\\\[/g, "\\[")
    .replace(/\\\\\]/g, "\\]"));
}

function applyActionInferences(action) {
  if (action?.type === "finalSubmit") {
    const probe = `${action.selector ?? ""} ${action.text ?? ""} ${action.reason ?? ""}`;

    if (nonFinalStepText.test(probe) && !finalSubmitText.test(probe)) {
      return {
        ...action,
        type: "intent",
        intent: inferIntentFromStepText(probe),
        inferredType: "finalSubmit_non_final_step",
      };
    }
  }

  if (action?.type === "intent") {
    return {
      ...action,
      intent: normalizeAiIntent(action.intent ?? action.name ?? action.value),
    };
  }

  if (
    action?.type === "clickText" &&
    !isMissing(action.selector) &&
    isMissing(action.text) &&
    isMissing(action.valueKey)
  ) {
    return {
      ...action,
      type: "click",
      inferredType: "clickText_with_selector",
    };
  }

  if (action?.type !== "finalSubmit" || !isMissing(action.selector)) {
    return action;
  }

  return {
    ...action,
    selector:
      "button:has-text(\"Generar Factura\"), a:has-text(\"Generar Factura\"), input[value*=\"Generar Factura\"]",
    inferredSelector: true,
  };
}

function inferIntentFromStepText(value) {
  if (/validar/i.test(value)) {
    return "validate";
  }

  if (/buscar|consultar/i.test(value)) {
    return "search";
  }

  if (/guardar/i.test(value)) {
    return "save";
  }

  if (/siguiente/i.test(value)) {
    return "next";
  }

  if (/aceptar/i.test(value)) {
    return "accept";
  }

  return "continue";
}

function normalizeAiIntent(value) {
  const normalized = String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();

  const aliases = {
    autofill: "fillVisibleFields",
    fill: "fillVisibleFields",
    fillvisible: "fillVisibleFields",
    fillvisiblefields: "fillVisibleFields",
    llenacamposvisibles: "fillVisibleFields",
    llenarcamposvisibles: "fillVisibleFields",
    buscar: "search",
    search: "search",
    consultar: "search",
    validate: "validate",
    validar: "validate",
    validarticket: "validate",
    continue: "continue",
    continuar: "continue",
    siguiente: "next",
    next: "next",
    save: "save",
    guardar: "save",
    registrar: "save",
    addclient: "addClient",
    agregarcliente: "addClient",
    nuevocliente: "addClient",
    confirm: "confirmModal",
    confirmar: "confirmModal",
    confirmmodal: "confirmModal",
    aceptarmodal: "confirmModal",
    accept: "accept",
    aceptar: "accept",
    selectpersontype: "selectPersonType",
    personatype: "selectPersonType",
    seleccionarpersona: "selectPersonType",
    personafisica: "selectPersonType",
    personamoral: "selectPersonType",
    download: "downloadCfdi",
    downloadcfdi: "downloadCfdi",
    descargacfdi: "downloadCfdi",
    descargarcfdi: "downloadCfdi",
  };

  return aliases[normalized.replace(/\s+/g, "")] ?? value;
}

function applyPlanInferences(plan) {
  if (!plan || typeof plan !== "object") {
    return plan;
  }

  if (typeof plan.status === "string") {
    return plan;
  }

  return {
    ...plan,
    status: Array.isArray(plan.actions) && plan.actions.length ? "in_progress" : "cannot_solve",
  };
}

function escapeUnescapedIdColon(selector) {
  return selector.replace(/#([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)/g, "#$1\\:$2");
}

function isMissing(value) {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}
