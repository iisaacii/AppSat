const valueKeyToField = new Map([
  ["ticket.ticketId", "ticketId"],
  ["ticket.codigoFacturacion", "ticketId"],
  ["ticket.folio", "folio"],
  ["ticket.sucursal", "sucursal"],
  ["ticket.tienda", "tienda"],
  ["ticket.serie", "serie"],
  ["ticket.token", "token"],
  ["ticket.fecha", "fecha"],
  ["ticket.monto", "monto"],
  ["ticket.formaPago", "paymentMethod"],
  ["ticket.paymentMethod", "paymentMethod"],
  ["taxProfile.rfc", "taxRfc"],
  ["taxProfile.legalName", "taxLegalName"],
  ["taxProfile.email", "taxEmail"],
  ["taxProfile.postalCode", "taxPostalCode"],
  ["taxProfile.fiscalRegime", "taxFiscalRegime"],
  ["taxProfile.cfdiUse", "taxCfdiUse"],
]);

export function templateFieldFromValueKey(valueKey) {
  return valueKeyToField.get(valueKey) ?? null;
}

export function isCaptchaElement(element, action = {}) {
  const probe = [
    element?.attrs?.id,
    element?.attrs?.name,
    element?.attrs?.placeholder,
    element?.attrs?.["aria-label"],
    element?.beforeText,
    element?.text,
    action?.valueKey,
    action?.selectedTextHint,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return /captcha|recaptcha|no soy un robot/.test(probe);
}

export function isPaymentMethodElement(element, action = {}) {
  const probe = [
    element?.attrs?.id,
    element?.attrs?.name,
    element?.beforeText,
    element?.text,
    action?.selectedTextHint,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return /forma\s*de\s*pago|formapago|metodo\s*de\s*pago|m[eé]todo\s*de\s*pago|tarjeta|cr[eé]dito|credito|d[eé]bito|debito|efectivo/.test(
    probe,
  );
}

export function buildTemplateStepForAction(action, element, context = {}) {
  if (["done", "scroll", "read_file", "search_page"].includes(action.type)) {
    return { kind: "skip", reason: "terminal_action" };
  }

  if (action.type === "waitForLoadState") {
    return {
      kind: "step",
      step: {
        type: "waitForLoadState",
        state: "domcontentloaded",
        timeoutMs: Math.max(1000, Number(action.seconds ?? 1) * 1000),
      },
      confidence: 0.55,
      reason: "browser_use_wait",
    };
  }

  if (!element && action.type === "click" && action.stableSelectorRequired) {
    return {
      kind: "skip",
      reason: "stale_browser_use_click_without_element",
    };
  }

  if (!element && action.stableSelectorRequired) {
    return {
      kind: "unresolved",
      reason: "element_index_not_found",
      action,
    };
  }

  if (element && isCaptchaElement(element, action)) {
    return {
      kind: "stop",
      reason: "captcha_required",
      step: buildDynamicStop("captcha_required"),
    };
  }

  if (["fill", "setValue", "select"].includes(action.type)) {
    const inferredFieldName = action.type === "select" && isPaymentMethodElement(element, action) ? "paymentMethod" : null;
    const fieldName = templateFieldFromValueKey(action.valueKey) ?? inferredFieldName ?? inferFieldNameFromElement(element);

    if (shouldSkipReadonlyPintureriasFiscalField(fieldName, action, context)) {
      return {
        kind: "skip",
        reason: "pinturerias_readonly_fiscal_review_field",
      };
    }

    if (!fieldName) {
      return {
        kind: "unresolved",
        reason: "value_key_missing",
        action,
        element,
      };
    }

    const selector = bestCssSelectorForElement(element) ?? fallbackSelectorForField(fieldName, action, element);

    if (!selector) {
      return {
        kind: "unresolved",
        reason: "selector_missing",
        action,
        element,
      };
    }

    return {
      kind: "step",
      step: {
        type: action.type === "select" ? "select" : "fill",
        selector: selector.selector,
        valueFrom: fieldName,
      },
      confidence: selector.confidence,
      reason: selector.reason,
      selector,
      fieldName,
    };
  }

  if (action.type === "click") {
    const visibleText = normalizeVisibleText(element?.text || element?.beforeText);

    const selectStep = buildSelectStepFromComboboxClick(action, element);

    if (selectStep) {
      return selectStep;
    }

    if (normalizeTag(element?.tag) === "mat-option" || element?.attrs?.role === "option") {
      return {
        kind: "skip",
        reason: "option_click_handled_by_select_control",
      };
    }

    const selector = fallbackSelectorForClick(action, element, context) ?? bestCssSelectorForElement(element);

    if (context.captchaDetected && /facturar|generar|emitir|timbrar/i.test(visibleText)) {
      return {
        kind: "stop",
        reason: "captcha_required",
        step: buildDynamicStop("captcha_required"),
      };
    }

    if (/facturar|generar factura|emitir|timbrar/i.test(visibleText)) {
      if (!selector) {
        return {
          kind: "unresolved",
          reason: "final_submit_selector_missing",
          action,
          element,
        };
      }

      return {
        kind: "step",
        step: {
          type: "finalSubmit",
          selector: selector.selector,
          allowSubmit: true,
          waitUntil: "domcontentloaded",
        },
        confidence: selector.confidence,
        reason: "final_submit_button",
        selector,
      };
    }

    if (selector?.confidence >= 0.8 && ["button", "a", "label", "img"].includes(element?.tag)) {
      return {
        kind: "step",
        step: {
          type: "click",
          selector: selector.selector,
          waitUntil: "domcontentloaded",
        },
        confidence: selector.confidence,
        reason: selector.reason,
        selector,
      };
    }

    if (visibleText && visibleText.length <= 80 && ["button", "a", "label", "div", "span"].includes(element?.tag)) {
      return {
        kind: "step",
        step: {
          type: "clickText",
          text: visibleText,
          exact: false,
          timeoutMs: 15000,
        },
        confidence: 0.72,
        reason: "visible_text_click",
      };
    }

    if (selector) {
      return {
        kind: "step",
        step: {
          type: "click",
          selector: selector.selector,
          waitUntil: "domcontentloaded",
        },
        confidence: selector.confidence,
        reason: selector.reason,
        selector,
      };
    }

    return {
      kind: "unresolved",
      reason: "click_selector_missing",
      action,
      element,
    };
  }

  return {
    kind: "skip",
    reason: `unsupported_action_${action.type}`,
  };
}

export function buildDynamicStop(reason) {
  const message =
    reason === "captcha_required"
      ? "Capa A llego a un CAPTCHA o paso dinamico; hacer handoff automatico a Capa B/B3."
      : "Capa A requiere selectores estables adicionales; hacer handoff automatico a Capa B/B3.";

  return {
    type: "stop",
    status: "needs_user_action",
    reason,
    message,
    captureArtifacts: true,
  };
}

export function bestCssSelectorForElement(element) {
  if (!element) {
    return null;
  }

  const candidates = generateCssSelectorCandidates(element);

  return candidates.sort((a, b) => b.confidence - a.confidence)[0] ?? null;
}

export function generateCssSelectorCandidates(element) {
  const attrs = element.attrs ?? {};
  const tag = normalizeTag(element.tag);
  const candidates = [];
  const nearby = normalizeVisibleText(`${element.beforeText ?? ""} ${element.text ?? ""}`).toLowerCase();

  if (attrs.name === "noTicket" && nearby.includes("ticket")) {
    candidates.push({
      selector: '#formAddTicket input[name="noTicket"]',
      confidence: 0.94,
      reason: "scoped_ticket_form",
    });
  }

  if (tag === "button" && normalizeVisibleText(element.text).toLowerCase() === "agregar ticket") {
    candidates.push({
      selector: '#formAddTicket button:has-text("Agregar Ticket")',
      confidence: 0.94,
      reason: "scoped_add_ticket_button",
    });
  }

  const sevenExpressFiscalFields = new Set([
    "rfcCliente",
    "razon",
    "regimenFiscalReceptor",
    "usoCfdi",
    "cp",
    "emailInput",
    "formaPago",
  ]);

  if (attrs.id && sevenExpressFiscalFields.has(attrs.id)) {
    candidates.push({
      selector: `#basicForm #${cssEscapeIdent(attrs.id)}`,
      confidence: 0.96,
      reason: "scoped_seven_express_tax_form",
    });
  }

  if (attrs.id) {
    candidates.push({
      selector: `#${cssEscapeIdent(attrs.id)}`,
      confidence: 0.95,
      reason: "id",
    });
  }

  if (attrs.name) {
    candidates.push({
      selector: `${tag}[name="${cssEscapeString(attrs.name)}"]`,
      confidence: 0.88,
      reason: "name",
    });
  }

  if (attrs.placeholder) {
    candidates.push({
      selector: `${tag}[placeholder="${cssEscapeString(attrs.placeholder)}"]`,
      confidence: 0.82,
      reason: "placeholder",
    });
  }

  if (attrs["aria-label"]) {
    candidates.push({
      selector: `${tag}[aria-label="${cssEscapeString(attrs["aria-label"])}"]`,
      confidence: 0.8,
      reason: "aria_label",
    });
  }

  if (attrs.alt && tag === "img") {
    candidates.push({
      selector: `img[alt="${cssEscapeString(attrs.alt)}"]`,
      confidence: 0.74,
      reason: "image_alt",
    });
  }

  const text = normalizeVisibleText(element.text);

  if (text && ["button", "a", "label"].includes(tag)) {
    candidates.push({
      selector: `${tag}:has-text("${cssEscapeString(text)}")`,
      confidence: 0.68,
      reason: "text",
    });
  }

  if (attrs.type && ["input", "button"].includes(tag)) {
    candidates.push({
      selector: `${tag}[type="${cssEscapeString(attrs.type)}"]`,
      confidence: 0.35,
      reason: "type_only_low_confidence",
    });
  }

  return candidates;
}

export function normalizeVisibleText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTag(tag) {
  const value = String(tag ?? "").toLowerCase();
  return /^[a-z][a-z0-9-]*$/.test(value) ? value : "*";
}

function cssEscapeString(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function inferFieldNameFromElement(element) {
  const attrs = element?.attrs ?? {};
  const probe = [attrs.id, attrs.name, attrs.placeholder, element?.beforeText, element?.text]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/\bserie\b/.test(probe)) return "serie";
  if (/\btoken\b/.test(probe)) return "token";
  if (/folio\s*ticket|numventa|ticket/.test(probe)) return "folio";
  if (/raz[oó]n\s*social/.test(probe)) return "taxLegalName";
  if (/\bcp\b|c[oó]digo\s*postal/.test(probe)) return "taxPostalCode";
  if (/correo|email/.test(probe)) return "taxEmail";
  if (/\brfc\b/.test(probe)) return "taxRfc";

  return null;
}

function fallbackSelectorForField(fieldName, action, element) {
  const attrs = element?.attrs ?? {};
  const id = attrs.id ?? attrs.name;

  if (fieldName === "serie") {
    return { selector: "#serie", confidence: 0.94, reason: "inferred_field_serie" };
  }

  if (fieldName === "token") {
    return { selector: "#token", confidence: 0.94, reason: "inferred_field_token" };
  }

  if (fieldName === "folio" && (id === "numVenta" || /folio|ticket/i.test(element?.beforeText ?? ""))) {
    return { selector: "#numVenta", confidence: 0.94, reason: "inferred_field_ticket_folio" };
  }

  const pintureriasFields = new Map([
    ["taxRfc", "#cdk-step-content-0-1 #rfc"],
    ["taxLegalName", '#cdk-step-content-0-1 mat-form-field:has(mat-label:has-text("Razón Social")) input'],
    ["taxPostalCode", "#cdk-step-content-0-1 #cp"],
    ["taxEmail", "#cdk-step-content-0-1 #email"],
  ]);

  if (pintureriasFields.has(fieldName)) {
    return {
      selector: pintureriasFields.get(fieldName),
      confidence: 0.9,
      reason: "inferred_pinturerias_fiscal_field",
    };
  }

  return null;
}

function fallbackSelectorForClick(action, element, context = {}) {
  const text = normalizeVisibleText(element?.text || element?.beforeText).toLowerCase();
  const step = Number(action?.step);
  const isPinturerias = String(context.selectedPortalUrl ?? "").includes("facturacionpintu.com.mx");

  if (isPinturerias && text === "buscar" && step <= 2) {
    return {
      selector: '#cdk-step-content-0-0 button:has-text("Buscar")',
      confidence: 0.94,
      reason: "scoped_pinturerias_rfc_search",
    };
  }

  if (isPinturerias && text === "siguiente") {
    return {
      selector: '#cdk-step-content-0-1 button:has-text("Siguiente")',
      confidence: 0.94,
      reason: "scoped_pinturerias_next",
    };
  }

  if (isPinturerias && text === "buscar" && step >= 6) {
    return {
      selector: '#cdk-step-content-0-2 button:has-text("Buscar")',
      confidence: 0.94,
      reason: "scoped_pinturerias_ticket_search",
    };
  }

  if (isPinturerias && text === "facturar") {
    return {
      selector: '#cdk-step-content-0-2 button:has-text("Facturar")',
      confidence: 0.94,
      reason: "scoped_pinturerias_final_submit",
    };
  }

  return null;
}

function shouldSkipReadonlyPintureriasFiscalField(fieldName, action, context = {}) {
  if (!String(context.selectedPortalUrl ?? "").includes("facturacionpintu.com.mx")) {
    return false;
  }

  if (Number(action?.step) !== 4) {
    return false;
  }

  return ["taxRfc", "taxLegalName", "taxPostalCode", "taxEmail"].includes(fieldName);
}

function buildSelectStepFromComboboxClick(action, element) {
  const tag = normalizeTag(element?.tag);
  const attrs = element?.attrs ?? {};
  const id = String(attrs.id ?? "");
  const probe = normalizeVisibleText(
    `${id} ${attrs.name ?? ""} ${attrs.placeholder ?? ""} ${element?.beforeText ?? ""} ${element?.text ?? ""}`,
  ).toLowerCase();

  if (tag !== "mat-select" && attrs.role !== "combobox") {
    return null;
  }

  let fieldName = null;

  if (/regimen|r[eé]gimen/.test(probe)) {
    fieldName = "taxFiscalRegime";
  } else if (/cfdi|uso/.test(probe)) {
    fieldName = "taxCfdiUse";
  } else if (/forma\s*de\s*pago|formapago|m[eé]todo\s*de\s*pago|payment/.test(probe)) {
    fieldName = "paymentMethod";
  }

  const selector = id ? `#${cssEscapeIdent(id)}` : bestCssSelectorForElement(element)?.selector;

  if (!fieldName || !selector) {
    return null;
  }

  return {
    kind: "step",
    step: {
      type: "select",
      selector,
      valueFrom: fieldName,
      timeoutMs: action.timeoutMs ?? 15000,
    },
    confidence: id ? 0.9 : 0.78,
    reason: "combobox_semantic_select",
    selector: {
      selector,
      confidence: id ? 0.9 : 0.78,
      reason: "combobox_semantic_select",
    },
    fieldName,
  };
}

function cssEscapeIdent(value) {
  const raw = String(value ?? "");

  if (/^-?[_a-zA-Z]+[_a-zA-Z0-9-]*$/.test(raw)) {
    return raw;
  }

  return raw
    .split("")
    .map((char) => {
      if (/[_a-zA-Z0-9-]/.test(char)) return char;
      return `\\${char}`;
    })
    .join("");
}
