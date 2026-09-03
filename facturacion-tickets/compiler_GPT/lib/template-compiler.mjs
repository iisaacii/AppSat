import { validatePortalTemplate } from "../../src/portals/template-schema.mjs";
import { buildElementMapsByStep, getB3Actions } from "./browser-use-history.mjs";
import { buildDynamicStop, buildTemplateStepForAction } from "./selector-generator.mjs";

export function compileB3CandidateToATemplate({ candidateDocument, historyDocument = null, options = {} }) {
  const sourceTemplate = candidateDocument.template ?? {};
  const learning = sourceTemplate.b3Learning ?? {};
  const selectedPortalUrl = normalizeUrl(learning.selectedPortalUrl ?? sourceTemplate.portalUrl);
  const actions = getB3Actions(candidateDocument, historyDocument);
  const elementMapsByStep = buildElementMapsByStep(historyDocument);
  const captchaDetected = Boolean(learning.captchaDetected ?? candidateDocument.promotion?.requiresDynamicAgent);
  const compileReport = {
    compiler: "compiler_GPT",
    generatedAt: new Date().toISOString(),
    sourceTemplateId: sourceTemplate.id ?? null,
    sourceCandidateStatus: candidateDocument.status ?? null,
    selectedPortalUrl,
    totalActions: actions.length,
    compiledActions: [],
    skippedActions: [],
    unresolvedActions: [],
    stopReason: null,
    selectorConfidenceMin: null,
    selectorConfidenceAvg: null,
    domMapsFound: elementMapsByStep.size,
  };
  const steps = [
    {
      type: "goto",
      url: selectedPortalUrl,
      waitUntil: "domcontentloaded",
      timeoutMs: 30000,
    },
  ];
  const startIndex = findStartActionIndex(actions, selectedPortalUrl);
  const selectorConfidences = [];
  let stopped = false;

  for (const action of actions.slice(startIndex)) {
    if (stopped) {
      compileReport.skippedActions.push({
        action,
        reason: "after_stop",
      });
      continue;
    }

    if (action.type === "goto") {
      compileReport.skippedActions.push({
        action,
        reason: "navigation_collapsed_to_selected_portal",
      });
      continue;
    }

    const element = lookupElementForAction(action, elementMapsByStep);
    const compiled = buildTemplateStepForAction(action, element, {
      captchaDetected,
      selectedPortalUrl,
    });

    if (compiled.kind === "step") {
      if (isDuplicateCompiledStep(steps, compiled.step)) {
        compileReport.skippedActions.push({
          action,
          element: summarizeElement(element),
          reason: "duplicate_step",
          step: compiled.step,
        });
        continue;
      }

      steps.push(compiled.step);
      compileReport.compiledActions.push({
        action,
        element: summarizeElement(element),
        step: compiled.step,
        confidence: compiled.confidence ?? null,
        reason: compiled.reason ?? null,
        selector: compiled.selector ?? null,
      });

      if (Number.isFinite(compiled.confidence)) {
        selectorConfidences.push(compiled.confidence);
      }
      continue;
    }

    if (compiled.kind === "stop") {
      steps.push(compiled.step);
      compileReport.stopReason = compiled.reason;
      compileReport.compiledActions.push({
        action,
        element: summarizeElement(element),
        step: compiled.step,
        reason: compiled.reason,
      });
      stopped = true;
      continue;
    }

    if (compiled.kind === "unresolved") {
      compileReport.unresolvedActions.push({
        action,
        element: summarizeElement(element),
        reason: compiled.reason,
      });
      continue;
    }

    compileReport.skippedActions.push({
      action,
      reason: compiled.reason,
    });
  }

  applyCompilerPostProcessing(steps, {
    selectedPortalUrl,
    compileReport,
  });

  if (!stopped && compileReport.unresolvedActions.length) {
    steps.push(buildDynamicStop("b3_selector_extraction_required"));
    compileReport.stopReason = "b3_selector_extraction_required";
  }

  if (!stopped && captchaDetected) {
    steps.push(buildDynamicStop("captcha_required"));
    compileReport.stopReason = "captcha_required";
  }

  compileReport.selectorConfidenceMin = selectorConfidences.length ? Math.min(...selectorConfidences) : null;
  compileReport.selectorConfidenceAvg = selectorConfidences.length
    ? Number((selectorConfidences.reduce((sum, value) => sum + value, 0) / selectorConfidences.length).toFixed(3))
    : null;

  const template = {
    schemaVersion: "portal-template.v1",
    id: `compiled-gpt-${safeFilePart(sourceTemplate.rfcEmisor)}-${safeFilePart(getUrlHost(selectedPortalUrl))}`,
    name: `Compiled GPT ${sourceTemplate.rfcEmisor ?? "portal"}`,
    rfcEmisor: sourceTemplate.rfcEmisor,
    portalUrl: selectedPortalUrl,
    portalFamily: `compiled_gpt_${safeFilePart(getUrlHost(selectedPortalUrl))}`,
    requiredFields: ensureCompilerRequiredFields(sourceTemplate.requiredFields ?? [], steps),
    steps,
    rateLimit: sourceTemplate.rateLimit ?? {
      concurrency: 1,
      perMinute: 4,
    },
    compilerGPT: compileReport,
  };
  const validation = validatePortalTemplate(template);
  const hasDynamicStop = ["captcha_required", "b3_selector_extraction_required"].includes(compileReport.stopReason);
  const learningState = validation.ok
    ? hasDynamicStop
      ? "compiled_dynamic_stop"
      : compileReport.unresolvedActions.length
        ? "needs_dom_map"
        : "compiled_ready_for_replay"
    : "compiler_failed";

  return {
    status: validation.ok && !compileReport.unresolvedActions.length ? "compiled" : "draft",
    learningState,
    validation,
    template,
    compileReport,
    promotion: {
      readyForActive: false,
      requiresDynamicAgent: hasDynamicStop || Boolean(candidateDocument.promotion?.requiresDynamicAgent),
      handoffToBOnFailure: true,
      reason: hasDynamicStop ? compileReport.stopReason : "replay_required",
      requiredBeforeActive: [
        "review_compiled_selectors",
        "replay_once_without_llm",
        "replay_second_time_without_llm",
        "validate_cfdi_xml_pdf",
      ],
    },
  };
}

function ensureCompilerRequiredFields(fields, steps) {
  const nextFields = [...fields];
  const compilerFields = new Map([
    ["paymentMethod", { source: "formaPago", label: "Forma de pago" }],
    ["serie", { source: "serie", label: "Serie" }],
    ["token", { source: "token", label: "Token" }],
  ]);

  for (const [name, config] of compilerFields) {
    const hasStep = steps.some((step) => step.valueFrom === name);
    const hasField = nextFields.some((field) => (typeof field === "string" ? field === name : field?.name === name));

    if (hasStep && !hasField) {
      nextFields.push({
        name,
        ...config,
      });
    }
  }

  return nextFields;
}

function applyCompilerPostProcessing(steps, { selectedPortalUrl, compileReport }) {
  coalesceCfdiDownloadActions(steps, { compileReport });
  insertPintureriasEmailBeforeFinalSubmit(steps, {
    selectedPortalUrl,
    compileReport,
  });
}

function coalesceCfdiDownloadActions(steps, { compileReport }) {
  const clickableRecords = (compileReport.compiledActions ?? []).filter(
    (record) => record.step?.type === "click" && typeof record.step.selector === "string" && record.step.selector,
  );
  const xmlRecords = clickableRecords.filter((record) => classifyCfdiDownloadAction(record) === "xml");
  const pdfRecords = clickableRecords.filter((record) => classifyCfdiDownloadAction(record) === "pdf");

  if (!xmlRecords.length) {
    return;
  }

  const downloadRecords = [...xmlRecords, ...pdfRecords];
  const downloadSteps = new Set(downloadRecords.map((record) => record.step));
  const stepIndexes = steps
    .map((step, index) => (downloadSteps.has(step) ? index : -1))
    .filter((index) => index >= 0);

  if (!stepIndexes.length) {
    return;
  }

  const firstIndex = Math.min(...stepIndexes);
  const lastIndex = Math.max(...stepIndexes);
  const isContiguous = steps.slice(firstIndex, lastIndex + 1).every((step) => downloadSteps.has(step));

  if (!isContiguous) {
    compileReport.unresolvedActions.push({
      action: {
        type: "compilerPostProcess",
        reason: "cfdi_download_sequence_noncontiguous",
      },
      element: null,
      reason: "cfdi_download_sequence_noncontiguous",
    });
    return;
  }

  const xmlStep = xmlRecords[0].step;
  const pdfStep = pdfRecords[0]?.step ?? null;
  const downloadStep = {
    type: "download",
    selector: xmlStep.selector,
    xmlSelector: xmlStep.selector,
    ...(pdfStep ? { pdfSelector: pdfStep.selector } : {}),
    captureDownloads: true,
    timeoutMs: Math.max(30000, Number(xmlStep.timeoutMs ?? 0), Number(pdfStep?.timeoutMs ?? 0)),
  };
  const nextSteps = [];
  let inserted = false;

  for (const step of steps) {
    if (!downloadSteps.has(step)) {
      nextSteps.push(step);
      continue;
    }

    if (!inserted) {
      nextSteps.push(downloadStep);
      inserted = true;
    }
  }

  steps.splice(0, steps.length, ...nextSteps);

  for (const record of downloadRecords) {
    record.postProcessedAs = "cfdi_download";
  }

  compileReport.cfdiDownload = {
    status: "compiled",
    xmlSelector: xmlStep.selector,
    pdfSelector: pdfStep?.selector ?? null,
    sourceActionCount: downloadRecords.length,
  };
  compileReport.compiledActions.push({
    action: {
      type: "compilerPostProcess",
      reason: "coalesced_cfdi_download_actions",
    },
    element: null,
    step: downloadStep,
    confidence: 0.95,
    reason: "cfdi_download_controls",
  });
}

function classifyCfdiDownloadAction(record) {
  const text = normalizeDownloadText(
    [
      record.element?.text,
      record.element?.beforeText,
      record.element?.attrs?.title,
      record.element?.attrs?.["aria-label"],
      record.step?.selector,
    ]
      .filter(Boolean)
      .join(" "),
  );

  if (/\bxml\b|guardar\s+xml|descargar\s+xml|ver\s+xml/.test(text)) {
    return "xml";
  }

  if (/\bpdf\b|visualizar\s+formato|formato\s+impresion|descargar\s+factura/.test(text)) {
    return "pdf";
  }

  return null;
}

function normalizeDownloadText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function insertPintureriasEmailBeforeFinalSubmit(steps, { selectedPortalUrl, compileReport }) {
  if (!String(selectedPortalUrl ?? "").includes("facturacionpintu.com.mx")) {
    return;
  }

  const finalSubmitIndex = steps.findIndex((step) => step.type === "finalSubmit");

  if (finalSubmitIndex < 0) {
    return;
  }

  const hasEmailStep = steps.some((step) => step.selector === "#correo" && step.valueFrom === "taxEmail");

  if (hasEmailStep) {
    return;
  }

  const injectedSteps = [
    {
      type: "fill",
      selector: "#correo",
      valueFrom: "taxEmail",
      timeoutMs: 10000,
    },
    {
      type: "click",
      selector: 'button:has-text("Guardar Correo")',
      waitUntil: "domcontentloaded",
      timeoutMs: 10000,
    },
  ];

  steps.splice(finalSubmitIndex, 0, ...injectedSteps);
  compileReport.compiledActions.push({
    action: {
      type: "compilerPostProcess",
      reason: "pinturerias_requires_email_saved_before_final_submit",
    },
    element: null,
    step: injectedSteps,
    confidence: 0.86,
    reason: "pinturerias_email_gate",
  });
}

function isDuplicateCompiledStep(steps, nextStep) {
  if (!["fill", "setValue", "select", "check"].includes(nextStep.type)) {
    return false;
  }

  return steps.some(
    (step) =>
      step.type === nextStep.type &&
      step.selector === nextStep.selector &&
      step.valueFrom === nextStep.valueFrom,
  );
}

function findStartActionIndex(actions, selectedPortalUrl) {
  const selected = normalizeUrl(selectedPortalUrl);
  const exactIndex = actions.findIndex((action) => normalizeUrl(action.urlBefore) === selected);

  if (exactIndex >= 0) {
    return exactIndex;
  }

  const selectedHost = getUrlHost(selected);
  const hostIndex = actions.findIndex((action) => getUrlHost(action.urlBefore) === selectedHost);

  return Math.max(0, hostIndex);
}

function lookupElementForAction(action, elementMapsByStep) {
  if (!Number.isFinite(Number(action.browserUseIndex))) {
    return null;
  }

  const stepMap = elementMapsByStep.get(Number(action.step));
  const sameStepElement = stepMap?.byIndex?.get(Number(action.browserUseIndex));

  if (sameStepElement) {
    return sameStepElement;
  }

  for (const offset of [-1, 1, -2, 2]) {
    const nearby = elementMapsByStep.get(Number(action.step) + offset)?.byIndex?.get(Number(action.browserUseIndex));

    if (nearby) {
      return nearby;
    }
  }

  return null;
}

function summarizeElement(element) {
  if (!element) {
    return null;
  }

  return {
    index: element.index,
    tag: element.tag,
    attrs: element.attrs,
    text: element.text,
    beforeText: element.beforeText,
    inShadow: element.inShadow,
  };
}

function normalizeUrl(value) {
  const raw = String(value ?? "").trim();

  if (!raw) {
    return "";
  }

  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    return parsed.href.replace(/\/$/, "");
  } catch {
    return raw.replace(/\/$/, "");
  }
}

function getUrlHost(value) {
  try {
    return new URL(String(value ?? "")).hostname || "unknown";
  } catch {
    return "unknown";
  }
}

function safeFilePart(value) {
  return String(value ?? "unknown")
    .replace(/[^a-z0-9_.-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}
