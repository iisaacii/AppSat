import { validateExternalUrlStructure } from "../security/external-url-policy.mjs";

export function buildFlutterWebviewHandoff({
  reason,
  checkpoint = {},
  template = null,
  taxProfile = {},
  editableFields = [],
  portalMessage = null,
} = {}) {
  const rawInitialUrl = firstString(checkpoint.currentUrl, checkpoint.portalUrl, null);
  const initialUrl = normalizeSafeHandoffUrl(rawInitialUrl);

  if (!initialUrl) {
    return null;
  }

  const ticketData = compactObject({
    rfcEmisor: checkpoint.rfcEmisor,
    ...(checkpoint.ticketData ?? {}),
  });
  const fiscalData = compactObject({
    rfc: taxProfile.rfc,
    legalName: taxProfile.legalName,
    email: taxProfile.email,
    fiscalRegime: taxProfile.fiscalRegime,
    cfdiUse: taxProfile.cfdiUse,
    postalCode: taxProfile.postalCode,
    street: taxProfile.street,
    exteriorNumber: taxProfile.exteriorNumber,
    interiorNumber: taxProfile.interiorNumber,
    neighborhood: taxProfile.neighborhood,
    municipality: taxProfile.municipality,
    state: taxProfile.state,
    country: taxProfile.country,
  });
  const automation = buildWebviewAutomation({
    reason,
    template,
    ticketData,
    fiscalData,
    allowedHosts: buildAllowedAutofillHosts({ initialUrl, checkpoint, template }),
  });

  return {
    kind: "flutter_webview_handoff.v1",
    mode: "flutter_webview",
    initialUrl,
    currentUrl: checkpoint.currentUrl ?? null,
    reason: reason ?? checkpoint.reason ?? null,
    portalName: checkpoint.portalName ?? null,
    portalFamily: checkpoint.portalFamily ?? null,
    templateId: checkpoint.templateId ?? null,
    taxProfileId: checkpoint.taxProfileId ?? null,
    ticketData,
    fiscalData,
    prefillData: {
      ticket: ticketData,
      fiscal: fiscalData,
    },
    autofillHints: buildAutofillHints({ ticketData, fiscalData, editableFields }),
    autofill: automation,
    allowedAutofillHosts: automation.allowedHosts,
    portalMessage,
    expectedUserAction: expectedUserActionForReason(reason),
    completion: {
      preferred: "download_cfdi_or_upload_files",
      acceptedFiles: ["xml", "pdf"],
      xmlIsSufficientForFiscalUse: true,
      returnToApp: "appsat://billing/handoff-complete",
    },
    createdAt: new Date().toISOString(),
  };
}

function buildWebviewAutomation({ reason, template, ticketData, fiscalData, allowedHosts }) {
  const values = buildValueMap({ ticketData, fiscalData });
  const steps = buildAutomationSteps(template, values);

  return {
    kind: "webview_autofill.v1",
    strategy: "inject_javascript_in_flutter_webview",
    canRunInExternalBrowser: false,
    runWhen: ["onPageFinished", "afterUserNavigation", "manualRetryButton"],
    goal:
      reason === "captcha_required"
        ? "prefill_until_captcha"
        : "prefill_visible_fields_and_help_user_continue",
    values,
    steps,
    allowedHosts,
    script: buildAutofillScript({ values, steps }),
    fallback: {
      showCopyTray: true,
      message:
        "Si el portal bloquea el prellenado automatico, muestra estos datos al usuario para copiar y pegar dentro del WebView.",
    },
  };
}

function buildValueMap({ ticketData, fiscalData }) {
  return compactObject({
    rfcEmisor: ticketData.rfcEmisor,
    folio: ticketData.folio,
    ticketId: ticketData.ticketId,
    codigoFacturacion: ticketData.codigoFacturacion ?? ticketData.ticketId,
    fecha: ticketData.fecha,
    monto: ticketData.monto,
    permisoCre: ticketData.permisoCre,
    sucursal: ticketData.sucursal,
    serie: ticketData.serie,
    token: ticketData.token,
    terminal: ticketData.terminal,
    webId: ticketData.webId,
    rfcReceptor: fiscalData.rfc,
    taxRfc: fiscalData.rfc,
    legalName: fiscalData.legalName,
    taxLegalName: fiscalData.legalName,
    email: fiscalData.email,
    taxEmail: fiscalData.email,
    fiscalRegime: fiscalData.fiscalRegime,
    taxFiscalRegime: fiscalData.fiscalRegime,
    cfdiUse: fiscalData.cfdiUse,
    taxCfdiUse: fiscalData.cfdiUse,
    postalCode: fiscalData.postalCode,
    taxPostalCode: fiscalData.postalCode,
  });
}

function buildAutomationSteps(template, values) {
  if (!Array.isArray(template?.steps)) {
    return [];
  }

  return template.steps
    .map((step) => {
      if (!["click", "dispatchClick", "fill", "setValue", "select", "check", "stop"].includes(step?.type)) {
        return null;
      }

      if (step.type === "stop") {
        return {
          type: "stop",
          reason: step.reason ?? "manual_checkpoint",
          message: step.message ?? null,
        };
      }

      const valueKey = step.valueFrom ?? null;
      const value = valueKey ? values[valueKey] : undefined;

      if (["fill", "setValue", "select"].includes(step.type) && isMissing(value)) {
        return null;
      }

      return compactObject({
        type: step.type === "dispatchClick" ? "click" : step.type,
        selector: step.selector,
        text: step.text,
        valueKey,
        value,
        checked: step.checked,
        optional: step.optional === true,
        waitAfterMs: step.waitAfterMs ?? 700,
      });
    })
    .filter(Boolean);
}

function buildAutofillScript({ values, steps }) {
  const payload = JSON.stringify({ values, steps });

  return `
(function () {
  const payload = ${payload};
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const fire = (el) => {
    for (const type of ["input", "change", "blur"]) {
      el.dispatchEvent(new Event(type, { bubbles: true }));
    }
  };
  const find = async (selector, timeoutMs = 8000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const matches = Array.from(document.querySelectorAll(selector || "")).filter(visible);
      if (matches[0]) return matches[0];
      await wait(250);
    }
    return null;
  };
  const setValue = (el, value) => {
    const raw = value == null ? "" : String(value);
    if (el.tagName === "SELECT") {
      const normalized = raw.toLowerCase();
      const option = Array.from(el.options).find((item) => {
        return String(item.value).toLowerCase() === normalized ||
          String(item.textContent || "").toLowerCase().includes(normalized) ||
          normalized.includes(String(item.textContent || "").toLowerCase());
      });
      if (option) el.value = option.value;
    } else {
      el.focus();
      el.value = raw;
    }
    fire(el);
  };
  window.__appSatAutofill = { status: "running", startedAt: new Date().toISOString(), filled: [], failed: [] };
  (async () => {
    for (const step of payload.steps || []) {
      if (step.type === "stop") {
        window.__appSatAutofill.status = "checkpoint";
        window.__appSatAutofill.reason = step.reason;
        window.__appSatAutofill.message = step.message;
        break;
      }
      const el = await find(step.selector);
      if (!el) {
        window.__appSatAutofill.failed.push({ step, reason: "element_not_found" });
        if (!step.optional) break;
        continue;
      }
      if (step.type === "fill" || step.type === "setValue" || step.type === "select") {
        setValue(el, step.value);
        window.__appSatAutofill.filled.push({ selector: step.selector, valueKey: step.valueKey });
      } else if (step.type === "check") {
        el.checked = step.checked !== false;
        fire(el);
      } else if (step.type === "click") {
        el.click();
      }
      await wait(step.waitAfterMs || 700);
    }
    if (window.__appSatAutofill.status === "running") {
      window.__appSatAutofill.status = "done";
    }
  })();
})();
`.trim();
}

function buildAutofillHints({ ticketData, fiscalData, editableFields }) {
  const hints = [
    hint("rfcEmisor", "RFC emisor", ticketData.rfcEmisor),
    hint("folio", "Folio/ticket", ticketData.folio),
    hint("ticketId", "ID de ticket", ticketData.ticketId),
    hint("codigoFacturacion", "Codigo de facturacion", ticketData.codigoFacturacion),
    hint("fecha", "Fecha", ticketData.fecha),
    hint("monto", "Monto", ticketData.monto),
    hint("permisoCre", "Permiso CRE", ticketData.permisoCre),
    hint("sucursal", "Sucursal", ticketData.sucursal),
    hint("serie", "Serie", ticketData.serie),
    hint("token", "Token", ticketData.token),
    hint("rfcReceptor", "RFC receptor", fiscalData.rfc),
    hint("legalName", "Razon social", fiscalData.legalName),
    hint("email", "Correo", fiscalData.email),
    hint("fiscalRegime", "Regimen fiscal", fiscalData.fiscalRegime),
    hint("cfdiUse", "Uso CFDI", fiscalData.cfdiUse),
    hint("postalCode", "Codigo postal", fiscalData.postalCode),
  ].filter(Boolean);

  const editableKeys = new Set(editableFields.map((field) => field?.key).filter(Boolean));
  return hints.map((item) => ({
    ...item,
    editableInAppBeforeOpen: editableKeys.has(item.key),
  }));
}

function hint(key, label, value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return {
    key,
    label,
    value,
  };
}

function expectedUserActionForReason(reason) {
  switch (reason) {
    case "captcha_required":
      return "resolve_captcha_and_continue";
    case "login_required":
      return "login_or_create_account_manually";
    case "portal_blocked":
      return "open_portal_manually";
    default:
      return "continue_in_portal";
  }
}

function compactObject(source) {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== null && value !== undefined && value !== ""),
  );
}

function isMissing(value) {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function normalizeSafeHandoffUrl(value) {
  if (!value) {
    return null;
  }

  try {
    return validateExternalUrlStructure(value).href;
  } catch {
    return null;
  }
}

function buildAllowedAutofillHosts({ initialUrl, checkpoint, template }) {
  const values = [
    initialUrl,
    checkpoint.currentUrl,
    checkpoint.portalUrl,
    template?.portalUrl,
    ...(template?.steps ?? [])
      .filter((step) => step?.type === "goto")
      .map((step) => step.url),
  ];
  const hosts = new Set();

  for (const value of values) {
    const safe = normalizeSafeHandoffUrl(value);
    if (!safe) continue;
    hosts.add(new URL(safe).hostname.toLowerCase());
  }

  return [...hosts];
}
