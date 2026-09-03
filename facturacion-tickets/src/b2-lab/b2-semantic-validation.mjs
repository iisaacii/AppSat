const hardBlockPatterns = [
  {
    reason: "ticket_already_invoiced",
    pattern: /ticket.*facturad[oa].*previamente|ticket.*ya.*validado|ticket.*validado.*previamente|ya.*facturad[oa]|ya.*validado|comprobante.*generad[oa]/i,
    message: "El ticket ya fue validado o facturado previamente",
  },
  {
    reason: "ticket_expired",
    pattern: /ticket.*vencid[oa]|vigencia.*vencid[ao]|fuera.*vigencia|d[ií]as de vigencia/i,
    message: "El ticket esta vencido o fuera de vigencia",
  },
  {
    reason: "fiscal_rule_blocked",
    pattern: /r[eé]gimen fiscal diferente|ejercicio fiscal diferente|r[eé]gimen.*no.*permit/i,
    message: "El portal bloqueo por regla fiscal",
  },
  {
    reason: "ticket_not_found",
    pattern: /factura no existe|ticket no existe|no existe.*ticket|no se encontraron datos|datos.*ticket.*incorrect/i,
    message: "El portal no encontro el ticket o la factura con los datos ingresados",
  },
  {
    reason: "portal_access_denied",
    pattern: /403\s+forbidden|access\s+denied|access is denied|forbidden|security\s+check|cloudflare|distil\s+networks|perimeterx|sucuri|bot\s+detection|datadome/i,
    message: "El portal denego el acceso (403 / Bloqueo Anti-bot)",
  },
];

const fieldRules = [
  {
    id: "ticket.codigoFacturacion",
    valueKey: "ticket.codigoFacturacion",
    labelPattern: /c[oó]digo.*(facturaci[oó]n|fact|[uú]nico)|codigo.*(facturacion|fact|unico)/i,
    ticketKeys: ["codigoFacturacion", "codigoFact", "codigoUnico"],
  },
  {
    id: "ticket.folio",
    valueKey: "ticket.folio",
    labelPattern: /folio/i,
    excludePattern: /c[oó]digo|codigo|rfc/i,
    ticketKeys: ["folio", "folioTicket", "folioVenta"],
  },
  {
    id: "ticket.idVenta",
    valueKey: "ticket.idVenta",
    labelPattern: /id.*venta|venta.*id/i,
    ticketKeys: ["idVenta", "tc", "ticketId"],
  },
  {
    id: "ticket.tc",
    valueKey: "ticket.tc",
    labelPattern: /\btc\b|ticket|n[uú]mero.*ticket|numero.*ticket/i,
    excludePattern: /folio|c[oó]digo|codigo|token|fecha|date/i,
    ticketKeys: ["tc", "ticketId"],
  },
  {
    id: "ticket.serie",
    valueKey: "ticket.serie",
    labelPattern: /serie/i,
    ticketKeys: ["serie"],
  },
  {
    id: "ticket.token",
    valueKey: "ticket.token",
    labelPattern: /token/i,
    ticketKeys: ["token"],
  },
  {
    id: "ticket.sucursal",
    valueKey: "ticket.sucursal",
    labelPattern: /sucursal|tienda|branch/i,
    ticketKeys: ["sucursal", "tda"],
  },
  {
    id: "ticket.fecha",
    valueKey: "ticket.fecha",
    labelPattern: /fecha|date/i,
    ticketKeys: ["fecha"],
    kind: "date",
  },
  {
    id: "ticket.monto",
    valueKey: "ticket.monto",
    labelPattern: /total|importe|monto/i,
    ticketKeys: ["monto", "total"],
    kind: "money",
  },
  {
    id: "taxProfile.rfc",
    valueKey: "taxProfile.rfc",
    labelPattern: /\brfc\b|rfc.*(receptor|cliente|comprador)|receptor.*rfc|membres[ií]a.*rfc/i,
    excludePattern: /emisor|empresa emisora|rfc.*emisor/i,
    source: "taxProfile",
    sourceKeys: ["rfc"],
  },
  {
    id: "ticket.rfcEmisor",
    valueKey: "ticket.rfcEmisor",
    labelPattern: /rfc.*emisor|emisor.*rfc|empresa emisora/i,
    ticketKeys: ["rfcEmisor"],
  },
  {
    id: "taxProfile.postalCode",
    valueKey: "taxProfile.postalCode",
    labelPattern: /c[oó]digo postal|\bcp\b|postal/i,
    source: "taxProfile",
    sourceKeys: ["postalCode"],
  },
  {
    id: "taxProfile.email",
    valueKey: "taxProfile.email",
    labelPattern: /correo|email/i,
    source: "taxProfile",
    sourceKeys: ["email"],
  },
];

export function validateB2FieldValues(
  pageState,
  { ticket, taxProfile, fiscalCompliance, includeEmptyIssues = false, scope = "all" } = {},
) {
  const issues = [];
  const checked = [];
  const controls = [...(pageState.inputs ?? []), ...(pageState.selects ?? [])];

  for (const control of controls) {
    if (!controlMatchesScope(control, scope)) {
      continue;
    }

    const rule = matchFieldRule(control);

    if (!rule) {
      continue;
    }

    const expected = readExpectedValue(rule, { ticket, taxProfile, fiscalCompliance });
    const actual = control.value;

    if (expected === undefined || expected === null || String(expected).trim() === "") {
      continue;
    }

    checked.push({
      selector: control.selector,
      label: control.label,
      valueKey: rule.valueKey,
      expected,
      actual,
    });

    if (actual === undefined || actual === null || String(actual).trim() === "") {
      if (includeEmptyIssues && control.enabled !== false) {
        issues.push({
          type: "missing_field_value",
          recoverable: true,
          selector: control.selector,
          controlKind: control.kind,
          label: control.label,
          id: control.id,
          name: control.name,
          readonly: control.readonly,
          valueKey: rule.valueKey,
          expected,
          actual,
          message: `El campo ${control.label || control.selector} esta vacio y debe usar ${expected}`,
        });
      }
      continue;
    }

    if (!valuesMatch(actual, expected, rule.kind)) {
      issues.push({
        type: "field_value_mismatch",
        recoverable: true,
        selector: control.selector,
        controlKind: control.kind,
        label: control.label,
        id: control.id,
        name: control.name,
        readonly: control.readonly,
        valueKey: rule.valueKey,
        expected,
        actual,
        message: `El campo ${control.label || control.selector} tiene ${actual} pero debe usar ${expected}`,
      });
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    checked,
  };
}

export function buildB2RepairActions(issues = []) {
  return issues
    .filter((issue) => issue.recoverable && issue.selector && issue.valueKey)
    .map((issue) => ({
      type:
        issue.controlKind === "select" || issue.controlKind === "custom_select"
          ? "select"
          : issue.readonly
            ? "setValue"
            : "fill",
      selector: issue.selector,
      valueKey: issue.valueKey,
      reason: `semantic_repair:${issue.type}`,
    }));
}

export function classifyB2PortalBlocker(pageState) {
  const pageClassification = pageState.pageClassification ?? classifyB2PageState(pageState);
  const text = [
    pageState.title,
    pageState.url,
    pageState.bodyText,
    ...(pageState.alerts ?? []),
    ...(pageState.toastMessages ?? []),
    ...(pageState.securitySignals ?? []),
  ].join(" ");

  if (pageClassification.hardBlocked) {
    return {
      blocked: true,
      hard: true,
      reason: pageClassification.reason,
      statusMessage: pageClassification.statusMessage,
      pageKind: pageClassification.pageKind,
      signals: pageClassification.signals,
    };
  }

  for (const block of hardBlockPatterns) {
    if (block.pattern.test(text)) {
      return {
        blocked: true,
        hard: true,
        reason: block.reason,
        statusMessage: block.message,
        pageKind: pageClassification.pageKind,
        signals: pageClassification.signals,
      };
    }
  }

  return {
    blocked: false,
    hard: false,
    reason: null,
    statusMessage: null,
    pageKind: pageClassification.pageKind,
    signals: pageClassification.signals,
  };
}

export function inferB2FlowState(pageState, { readiness, blocker, downloads } = {}) {
  if (downloads?.xmlPath && downloads?.pdfPath) return "completed";
  if (blocker?.blocked) return "blocked";
  if ((pageState.downloadLinks ?? []).length) return "waiting_download";
  if (readiness?.ready) return "preview_or_confirm";
  if (pageState.pageClassification?.pageKind === "portal_landing") return "portal_landing";
  if (pageState.pageClassification?.pageKind === "login") return "login_or_express_selection";

  const text = normalize(`${pageState.bodyText ?? ""} ${(pageState.alerts ?? []).join(" ")}`);
  if (/datos fiscales|r[eé]gimen|uso cfdi|raz[oó]n social|codigo postal/.test(text)) return "filling_tax_profile";
  if (/validar ticket|ticket pendiente|folio.*venta|id.*venta/.test(text)) return "validating_ticket";
  return "filling_ticket";
}

export function classifyB2PageState(pageState) {
  const text = normalize(
    [
      pageState.url,
      pageState.title,
      pageState.bodyText,
      ...(pageState.alerts ?? []),
      ...(pageState.toastMessages ?? []),
      ...(pageState.securitySignals ?? []),
      ...(pageState.frames ?? []).map((frame) => `${frame.src ?? ""} ${frame.title ?? ""}`),
    ].join(" "),
  );
  const buttonsText = normalize((pageState.buttons ?? []).map((button) => button.text).join(" "));
  const linkText = normalize((pageState.links ?? []).map((link) => `${link.text} ${link.href}`).join(" "));
  const controlText = normalize(
    [...(pageState.inputs ?? []), ...(pageState.selects ?? [])]
      .map((control) => `${control.label ?? ""} ${control.placeholder ?? ""} ${control.name ?? ""} ${control.id ?? ""}`)
      .join(" "),
  );
  const signals = [...(pageState.securitySignals ?? [])];
  const hasSignal = (id) => signals.includes(id);
  const addSignal = (id) => {
    if (!signals.includes(id)) signals.push(id);
  };

  if (/403|forbidden|access is denied|access denied/.test(text)) addSignal("http_403");
  if (/cloudflare|cf-browser-verification|cf-chl|turnstile/.test(text)) addSignal("cloudflare");
  if (/perimeterx|px-captcha|_px/.test(text)) addSignal("perimeterx");
  if (/stormcaster|perfdrive|validate\.perfdrive/.test(text)) addSignal("stormcaster_perfdrive");
  if (/recaptcha|g-recaptcha|no soy un robot|captcha/.test(text)) addSignal("captcha");

  const hasAccessDeniedText = /403|forbidden|access is denied|access denied|you do not have permission/.test(text);

  if (
    hasSignal("http_403") ||
    hasSignal("cloudflare") ||
    hasSignal("perimeterx") ||
    hasSignal("distil") ||
    hasSignal("sucuri") ||
    hasSignal("datadome") ||
    (hasSignal("stormcaster_perfdrive") && hasAccessDeniedText)
  ) {
    return {
      pageKind: "technical_block",
      hardBlocked: true,
      reason: "portal_access_denied",
      statusMessage: "El portal denego el acceso (403 / Bloqueo Anti-bot)",
      signals,
      nextStrategy: "browserbase_or_mark_blocked",
    };
  }

  const visibleCaptchaText = normalize(
    [
      controlText,
      buttonsText,
      ...(pageState.alerts ?? []),
      ...(pageState.toastMessages ?? []),
    ].join(" "),
  );

  if (/captcha|recaptcha|no soy un robot/.test(visibleCaptchaText)) {
    return {
      pageKind: "captcha",
      hardBlocked: true,
      reason: "captcha_required",
      statusMessage: "El portal requiere CAPTCHA",
      signals,
      nextStrategy: "blocked",
    };
  }

  if (/iniciar sesi[oó]n|correo.*contrase[nñ]a|usuario.*contrase[nñ]a|login|password/.test(text)) {
    const hasExpressPath = /factura express|facturaci[oó]n express|facturar sin registro|factura r[aá]pida/.test(
      `${buttonsText} ${linkText}`,
    );

    return {
      pageKind: hasExpressPath ? "login_with_express_path" : "login",
      hardBlocked: false,
      reason: hasExpressPath ? "login_page_has_express_path" : "login_required",
      statusMessage: hasExpressPath
        ? "El portal muestra login, pero hay ruta de factura express"
        : "El portal requiere login o sesion del usuario",
      signals,
      nextStrategy: hasExpressPath ? "click_express_path" : "blocked_if_no_public_path",
    };
  }

  if (/xml|pdf|descargar|download|comprobante|cfdi/.test(`${buttonsText} ${linkText}`)) {
    return {
      pageKind: "download_ready",
      hardBlocked: false,
      reason: "download_controls_visible",
      statusMessage: "El portal muestra controles de descarga CFDI",
      signals,
      nextStrategy: "download_cfdi",
    };
  }

  if (/datos fiscales|r[eé]gimen|uso cfdi|raz[oó]n social|c[oó]digo postal|receptor/.test(`${text} ${controlText}`)) {
    return {
      pageKind: "tax_profile_form",
      hardBlocked: false,
      reason: "tax_profile_form_visible",
      statusMessage: "El portal muestra formulario fiscal",
      signals,
      nextStrategy: "fill_tax_profile",
    };
  }

  if (/folio|ticket|c[oó]digo.*fact|codigo.*fact|token|sucursal|tienda|total|importe|venta/.test(`${text} ${controlText}`)) {
    return {
      pageKind: "ticket_form",
      hardBlocked: false,
      reason: "ticket_form_visible",
      statusMessage: "El portal muestra formulario de ticket",
      signals,
      nextStrategy: "fill_ticket",
    };
  }

  if (
    /facturaci[oó]n electr[oó]nica|portal de facturaci[oó]n|factura aqu[ií]|ir al portal|factura express/.test(
      `${text} ${buttonsText} ${linkText}`,
    )
  ) {
    return {
      pageKind: "portal_landing",
      hardBlocked: false,
      reason: "portal_landing_with_invoice_links",
      statusMessage: "El portal muestra una pagina informativa con enlaces de facturacion",
      signals,
      nextStrategy: "follow_invoice_entrypoint",
    };
  }

  return {
    pageKind: "unknown",
    hardBlocked: false,
    reason: "page_state_unknown",
    statusMessage: "No se pudo clasificar claramente el estado del portal",
    signals,
    nextStrategy: "ask_model_for_next_safe_action",
  };
}

function matchFieldRule(control) {
  if (isLoginControl(control)) {
    return null;
  }

  const directProbe = normalize(
    [
      control.id,
      control.name,
      control.label,
      control.placeholder,
      control.visibleText,
    ]
      .filter(Boolean)
      .join(" "),
  );
  const directMatch = fieldRules.find(
    (rule) => rule.labelPattern.test(directProbe) && !(rule.excludePattern && rule.excludePattern.test(directProbe)),
  );

  if (directMatch) {
    return directMatch;
  }

  const nearbyProbe = normalize([control.sectionText].filter(Boolean).join(" "));
  return fieldRules.find(
    (rule) => rule.labelPattern.test(nearbyProbe) && !(rule.excludePattern && rule.excludePattern.test(nearbyProbe)),
  );
}

function controlMatchesScope(control, scope) {
  if (scope === "ticket") {
    const probe = normalize([control.id, control.name, control.label, control.placeholder, control.sectionText].join(" "));
    return /fecha|folio|venta|ticket|total|importe|monto|c[oó]digo|codigo|serie|token|sucursal|tienda|\btc\b/.test(
      probe,
    );
  }

  if (scope === "taxProfile") {
    const probe = normalize([control.id, control.name, control.label, control.placeholder, control.sectionText].join(" "));
    return /rfc|raz[oó]n social|nombre|calle|colonia|municipio|c[oó]digo postal|\bcp\b|estado|r[eé]gimen|cfdi|correo|email/.test(
      probe,
    );
  }

  return true;
}

function isLoginControl(control) {
  const probe = normalize([control.id, control.name, control.label, control.placeholder, control.type].join(" "));
  const context = normalize([control.sectionText, control.formText].join(" "));

  if (/password|contrase[nñ]a|pass\b/.test(probe)) {
    return true;
  }

  return /correo|email|usuario/.test(probe) && /ya est[aá]s registrado|contrase[nñ]a|olvidaste tu contrase[nñ]a|entrar/.test(context);
}

function readExpectedValue(rule, sources) {
  const source = rule.source === "taxProfile" ? sources.taxProfile : sources.ticket;
  const keys = rule.sourceKeys ?? rule.ticketKeys ?? [];

  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }

  return null;
}

function valuesMatch(actual, expected, kind) {
  if (kind === "money") {
    const actualNumber = parseMoney(actual);
    const expectedNumber = parseMoney(expected);
    return actualNumber !== null && expectedNumber !== null && Math.abs(actualNumber - expectedNumber) < 0.01;
  }

  if (kind === "date") {
    return normalizeDate(actual) === normalizeDate(expected);
  }

  return normalizeComparable(actual) === normalizeComparable(expected);
}

function parseMoney(value) {
  const number = Number(String(value ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function normalizeDate(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\./g, "");
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) return `${slash[3]}-${slash[2].padStart(2, "0")}-${slash[1].padStart(2, "0")}`;
  const monthName = text.match(/^(\d{1,2})[-/\s]+([a-z]+)[-/\s]+(\d{2,4})$/);
  if (monthName) {
    const months = {
      ene: "01",
      enero: "01",
      feb: "02",
      febrero: "02",
      mar: "03",
      marzo: "03",
      abr: "04",
      abril: "04",
      may: "05",
      mayo: "05",
      jun: "06",
      junio: "06",
      jul: "07",
      julio: "07",
      ago: "08",
      agosto: "08",
      sep: "09",
      sept: "09",
      septiembre: "09",
      oct: "10",
      octubre: "10",
      nov: "11",
      noviembre: "11",
      dic: "12",
      diciembre: "12",
    };
    const year = monthName[3].length === 2 ? `20${monthName[3]}` : monthName[3];
    const month = months[monthName[2]];
    if (month) return `${year}-${month}-${monthName[1].padStart(2, "0")}`;
  }
  return normalizeComparable(text);
}

function normalizeComparable(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/gi, "")
    .trim()
    .toUpperCase();
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
