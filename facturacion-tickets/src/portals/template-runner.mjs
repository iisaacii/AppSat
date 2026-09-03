import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  getPortalArtifactsDir,
  getPortalRunnerMode,
  isPortalFinalSubmitEnabled,
  shouldUsePortalFixture,
} from "../config/env.mjs";
import { logger } from "../shared/logger.mjs";
import {
  assertSafeExternalUrl,
  installSafePageNetworkGuard,
} from "../security/external-url-policy.mjs";
import {
  getSelectOptions as getPlaywrightSelectOptions,
  selectBestOption as selectPlaywrightBestOption,
} from "../shared/playwright-select-control.mjs";

const portalFixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");

export async function runPortalTemplate(template, context) {
  const mode = getPortalRunnerMode();

  logger.info("Running portal template.", {
    templateId: template.id,
    rfcEmisor: template.rfcEmisor,
    jobId: context.id,
    mode,
  });

  if (mode === "playwright") {
    return runPlaywrightTemplate(template, context);
  }

  return runMockTemplate(template, context);
}

async function runMockTemplate(template, context) {
  for (const step of template.steps) {
    logger.info("Template step.", {
      type: step.type,
      selector: step.selector ?? null,
      valueFrom: step.valueFrom ?? null,
    });
    await sleep(150);

    if (step.type === "stop") {
      return buildStopResult(step, template, context);
    }
  }

  return {
    xmlUrl: `mock://storage/cfdis/${context.id}.xml`,
    pdfUrl: `mock://storage/cfdis/${context.id}.pdf`,
  };
}

async function runPlaywrightTemplate(template, context) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== "false",
  });

  try {
    const page = await browser.newPage();
    const networkPolicy = buildPortalNetworkPolicy();
    await installSafePageNetworkGuard(page, networkPolicy);
    const hasGotoStep = template.steps.some((step) => step.type === "goto");

    if (!hasGotoStep) {
      await safePageGoto(page, resolvePortalUrl(template), { waitUntil: "domcontentloaded" }, networkPolicy);
    }

    let result = null;
    const scratch = {};

    for (const step of template.steps) {
      logger.info("Template step.", {
        type: step.type,
        selector: step.selector ?? null,
        valueFrom: step.valueFrom ?? null,
      });

      try {
        const stepResult = await runPlaywrightStep(page, step, context, template, scratch);

        if (stepResult) {
          result = stepResult;
        }

        if (stepResult?.stop) {
          return stepResult;
        }
      } catch (error) {
        if (step.optional) {
          logger.info("Optional template step skipped.", {
            type: step.type,
            selector: step.selector ?? null,
            text: step.text ?? null,
          });
          continue;
        }

        const artifacts = await captureStepArtifacts(page, {
          step,
          context,
          template,
          suffix: "step-error",
        }).catch((artifactError) => {
          logger.warn("Step error artifact capture failed.", {
            templateId: template.id,
            jobId: context.id,
            error: artifactError.message,
          });
          return {};
        });
        const businessStop = await detectBusinessStop(page);

        if (businessStop) {
          logger.info("Template stopped on portal business message.", {
            templateId: template.id,
            jobId: context.id,
            type: step.type,
            selector: step.selector ?? null,
            reason: businessStop.reason,
            portalMessage: businessStop.message,
            artifacts,
          });
          return buildStopResult(
            {
              status: businessStop.status,
              reason: businessStop.reason,
              message: businessStop.message,
            },
            template,
            context,
            {
              ...artifacts,
              portalMessages: [businessStop.message],
            },
          );
        }
        logger.error("Template step failed.", {
          templateId: template.id,
          jobId: context.id,
          type: step.type,
          selector: step.selector ?? null,
          error: error.message,
          artifacts,
        });
        throw error;
      }
    }

    if (result) return result;
    if (shouldUsePortalFixture()) {
      return {
        xmlUrl: `playwright://storage/cfdis/${context.id}.xml`,
        pdfUrl: `playwright://storage/cfdis/${context.id}.pdf`,
      };
    }
    throw buildCfdiArtifactMissingError("La receta termino sin descargar XML o PDF.");
  } finally {
    await browser.close();
  }
}

async function runPlaywrightStep(page, step, context, template, scratch) {
  if (step.type === "goto") {
    await safePageGoto(page, resolvePortalUrl(template, context, step), {
      waitUntil: step.waitUntil ?? "domcontentloaded",
      timeout: step.timeoutMs ?? 30000,
    }, buildPortalNetworkPolicy());
    return null;
  }

  if (step.type === "fill") {
    await page.locator(step.selector).fill(String(readPath(context, step.valueFrom) ?? ""), {
      timeout: step.timeoutMs ?? 10000,
    });
    return null;
  }

  if (step.type === "setValue") {
    await setElementValue(page.locator(step.selector), readPath(context, step.valueFrom), step);
    return null;
  }

  if (step.type === "select") {
    await selectPlaywrightBestOption(page, page.locator(step.selector), readPath(context, step.valueFrom), step);
    return null;
  }

  if (step.type === "selectOrStop") {
    try {
      await selectPlaywrightBestOption(page, page.locator(step.selector), readPath(context, step.valueFrom), step);
      return null;
    } catch (error) {
      const availableOptions = await getPlaywrightSelectOptions(page.locator(step.selector)).catch(() => []);

      logger.info("Template select option was not available; stopping safely.", {
        templateId: template.id,
        jobId: context.id,
        selector: step.selector,
        valueFrom: step.valueFrom,
        reason: step.reason ?? "select_option_not_available",
        error: error.message,
        availableOptions,
      });

      return captureSafeStopResult(page, step, context, template, {
        selectError: error.message,
        availableOptions,
      });
    }
  }

  if (step.type === "check") {
    await page.locator(step.selector).setChecked(step.checked ?? true, {
      timeout: step.timeoutMs ?? 10000,
    });
    return null;
  }

  if (step.type === "click") {
    await page.locator(step.selector).click({ timeout: step.timeoutMs ?? 10000 });
    await afterActionWait(page, step);
    return null;
  }

  if (step.type === "finalSubmit") {
    await context.assertClaimActive?.();
    const finalSubmitGuard = buildFinalSubmitGuard(context, step);

    if (!finalSubmitGuard.ready) {
      logger.info("Final portal submit blocked by guard.", {
        templateId: template.id,
        jobId: context.id,
        selector: step.selector,
        ...finalSubmitGuard,
      });
      return captureSafeStopResult(page, step, context, template, {
        finalSubmitGuard,
      });
    }

    await page.locator(step.selector).click({ timeout: step.timeoutMs ?? 10000 });
    await afterActionWait(page, step);
    return null;
  }

  if (step.type === "dispatchClick") {
    const locator = page.locator(step.selector);
    await locator.waitFor({ state: "attached", timeout: step.timeoutMs ?? 10000 });
    await locator.dispatchEvent("click");
    await afterActionWait(page, step);
    return null;
  }

  if (step.type === "clickText") {
    const text = step.text ?? readPath(context, step.textFrom);
    await page.getByText(String(text ?? ""), { exact: step.exact ?? false }).click({
      timeout: step.timeoutMs ?? 10000,
    });
    await afterActionWait(page, step);
    return null;
  }

  if (step.type === "waitForSelector") {
    await page.locator(step.selector).first().waitFor({
      state: step.state ?? "visible",
      timeout: step.timeoutMs ?? 10000,
    });
    return null;
  }

  if (step.type === "waitForSelectorOrStop") {
    const outcome = await waitForSelectorOrCollectMessages(page, step);

    if (outcome.found) {
      return null;
    }

    logger.info("Template selector did not become available; stopping safely.", {
      templateId: template.id,
      jobId: context.id,
      selector: step.selector,
      reason: step.reason ?? "template_safe_stop",
      error: outcome.error?.message ?? null,
      portalMessages: outcome.portalMessages,
    });
    return captureSafeStopResult(page, step, context, template, {
      portalMessages: outcome.portalMessages,
    });
  }

  if (step.type === "waitForText") {
    const text = step.text ?? readPath(context, step.textFrom);
    await page.getByText(String(text ?? ""), { exact: step.exact ?? false }).waitFor({
      state: "visible",
      timeout: step.timeoutMs ?? 10000,
    });
    return null;
  }

  if (step.type === "waitForUrl") {
    await page.waitForURL(step.url, {
      timeout: step.timeoutMs ?? 10000,
      waitUntil: step.waitUntil ?? "domcontentloaded",
    });
    return null;
  }

  if (step.type === "waitForLoadState") {
    await waitForPortalLoadState(page, step.state ?? "domcontentloaded", step.timeoutMs ?? 10000, {
      step,
      template,
      context,
    });
    return null;
  }

  if (step.type === "extractAttribute") {
    const locator = page.locator(step.selector);
    await locator.waitFor({ state: "visible", timeout: step.timeoutMs ?? 10000 });
    scratch[step.saveAs] = await locator.getAttribute(step.attribute);
    return null;
  }

  if (step.type === "download") {
    return extractDownloadUrls(page, step, context, template, scratch);
  }

  if (step.type === "stop") {
    return captureSafeStopResult(page, step, context, template);
  }

  throw new Error(`Unsupported template step type: ${step.type}`);
}

async function detectBusinessStop(page) {
  const text = await page
    .locator("body")
    .innerText({ timeout: 1000 })
    .catch(() => "");
  const normalized = text.replace(/\s+/g, " ").trim();

  if (/ticket\s+ya\s+fu[eé]\s+facturado|ya\s+fu[eé]\s+facturad[oa]|ticket\s+ya\s+facturado/i.test(normalized)) {
    return {
      status: "needs_user_action",
      reason: "ticket_already_invoiced",
      message: "El portal indica que el ticket ya fue facturado.",
    };
  }

  if (/ticket\s+no\s+existe|no\s+se\s+encontraron\s+datos|factura\s+no\s+existe/i.test(normalized)) {
    return {
      status: "needs_user_action",
      reason: "ticket_not_found",
      message: "El portal indica que no encontro datos para el ticket.",
    };
  }

  return null;
}

async function captureSafeStopResult(page, step, context, template, metadata = {}) {
  const artifacts = await captureStopArtifacts(page, step, context, template).catch((error) => {
    logger.warn("Safe stop artifact capture failed.", {
      templateId: template.id,
      jobId: context.id,
      error: error.message,
    });
    return {};
  });

  return buildStopResult(step, template, context, { ...artifacts, ...metadata });
}

function buildStopResult(step, template, context, artifacts = {}) {
  const { finalSubmitGuard, ...artifactPayload } = artifacts;
  const portalMessage = artifactPayload.portalMessages?.[0] ?? null;

  return {
    stop: true,
    safeStop: true,
    requiresUserAction: true,
    status: step.status ?? "needs_user_action",
    statusMessage: portalMessage ?? step.message ?? "Ejecucion detenida antes del paso final",
    reason: step.reason ?? "template_safe_stop",
    portalMessage,
    portalMessages: artifactPayload.portalMessages ?? [],
    templateId: template.id,
    jobId: context.id,
    ...(finalSubmitGuard ? { finalSubmitGuard } : {}),
    artifacts: artifactPayload,
    xmlUrl: null,
    pdfUrl: null,
  };
}

function buildFinalSubmitGuard(context, step) {
  const checks = {
    templateAllowsFinalSubmit: step.allowSubmit === true,
    workerAllowsFinalSubmit: isPortalFinalSubmitEnabled(),
    jobApprovedFinalSubmit: context.portalFinalSubmitApproved === true,
  };
  const blockedBy = [];

  if (!checks.templateAllowsFinalSubmit) blockedBy.push("template_allow_submit_false");
  if (!checks.workerAllowsFinalSubmit) blockedBy.push("worker_allow_submit_false");
  if (!checks.jobApprovedFinalSubmit) blockedBy.push("job_final_submit_not_approved");

  return {
    ready: blockedBy.length === 0,
    blockedBy,
    ...checks,
  };
}

async function extractDownloadUrls(page, step, context, template, scratch) {
  const locator = page.locator(step.selector);
  await locator.first().waitFor({ state: "visible", timeout: step.timeoutMs ?? 10000 });

  const xmlLocator = step.captureXml === false ? null : step.xmlSelector ? page.locator(step.xmlSelector) : locator;
  const pdfLocator = step.capturePdf === false ? null : step.pdfSelector ? page.locator(step.pdfSelector) : null;

  if (step.xmlSelector) {
    await xmlLocator.waitFor({ state: "visible", timeout: step.timeoutMs ?? 10000 });
  }

  if (step.pdfSelector) {
    await pdfLocator.waitFor({ state: "visible", timeout: step.timeoutMs ?? 10000 });
  }

  if (step.captureDownloads === true) {
    const downloads = await captureCfdiDownloads(page, step, context, template, {
      xmlLocator,
      pdfLocator,
    });

    if (downloads.xmlPath || downloads.pdfPath) {
      return {
        ...downloads,
        xmlUrl:
          scratch.xmlUrl ??
          downloads.xmlUrl ??
          (await firstAttribute(xmlLocator, ["data-xml-url", "data-download-url", "href"])) ??
          null,
        pdfUrl:
          scratch.pdfUrl ??
          downloads.pdfUrl ??
          (await firstAttribute(pdfLocator, ["data-pdf-url", "data-download-url", "href"])) ??
          null,
      };
    }

    logger.warn("Browser CFDI downloads were incomplete; falling back to URL extraction.", {
      jobId: context.id,
      xmlPath: downloads.xmlPath ?? null,
      pdfPath: downloads.pdfPath ?? null,
      downloadErrors: downloads.downloadErrors ?? [],
    });
  }

  const extractedResult = {
    xmlUrl:
      scratch.xmlUrl ??
      (await firstAttribute(xmlLocator, ["data-xml-url", "data-download-url", "href"])) ??
      null,
    pdfUrl:
      scratch.pdfUrl ??
      (await firstAttribute(pdfLocator, ["data-pdf-url", "data-download-url", "href"])) ??
      null,
  };
  if (extractedResult.xmlUrl || extractedResult.pdfUrl) return extractedResult;
  if (shouldUsePortalFixture()) {
    return {
      xmlUrl: `playwright://storage/cfdis/${context.id}.xml`,
      pdfUrl: `playwright://storage/cfdis/${context.id}.pdf`,
    };
  }
  throw buildCfdiArtifactMissingError("El portal mostro acciones de descarga, pero no entrego archivos ni URLs.");
}

function buildCfdiArtifactMissingError(message) {
  const error = new Error(message);
  error.code = "cfdi_artifact_missing";
  return error;
}

async function captureCfdiDownloads(page, step, context, template, locators) {
  const result = {
    downloadMode: "browser",
    downloadErrors: [],
  };

  const xmlDownload = locators.xmlLocator
    ? await captureDownloadFile(page, {
        locator: locators.xmlLocator,
        kind: "xml",
        step,
        context,
        template,
      }).catch((error) => {
        result.downloadErrors.push({ kind: "xml", error: error.message });
        return null;
      })
    : null;

  if (xmlDownload) {
    result.xmlPath = xmlDownload.path;
    result.xmlDownloadFileName = xmlDownload.fileName;
    result.xmlUrl = xmlDownload.url;
  }

  const pdfDownload = locators.pdfLocator
    ? await captureDownloadFile(page, {
        locator: locators.pdfLocator,
        kind: "pdf",
        step,
        context,
        template,
      }).catch((error) => {
        result.downloadErrors.push({ kind: "pdf", error: error.message });
        return null;
      })
    : null;

  if (pdfDownload) {
    result.pdfPath = pdfDownload.path;
    result.pdfDownloadFileName = pdfDownload.fileName;
    result.pdfUrl = pdfDownload.url;
  }

  return result;
}

async function captureDownloadFile(page, { locator, kind, step, context, template }) {
  const timeoutMs = step.downloadTimeoutMs ?? step.timeoutMs ?? 30000;
  const configuredDir = step.downloadsDir ?? getPortalArtifactsDir();
  const outputDir = resolve(configuredDir);

  await mkdir(outputDir, { recursive: true });

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: timeoutMs }),
    locator.first().click({
      timeout: step.timeoutMs ?? 10000,
      noWaitAfter: true,
    }),
  ]);
  const suggested = sanitizeDownloadFileName(download.suggestedFilename?.() ?? `cfdi.${kind}`, kind);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${safeFilePart(template.id)}-${safeFilePart(context.id)}-${stamp}-${kind}-${suggested}`;
  const outputPath = resolve(outputDir, fileName);

  await download.saveAs(outputPath);

  return {
    path: displayArtifactPath(configuredDir, fileName),
    fileName: suggested,
    url: typeof download.url === "function" ? download.url() : null,
  };
}

function sanitizeDownloadFileName(value, kind) {
  const fallback = `cfdi.${kind}`;
  const fileName = String(value ?? fallback)
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");

  return fileName || fallback;
}

async function firstAttribute(locator, names) {
  if (!locator) {
    return null;
  }

  for (const name of names) {
    const value = await locator.getAttribute(name).catch(() => null);

    if (value && value !== "#") {
      return value;
    }
  }

  return null;
}

async function waitForSelectorOrCollectMessages(page, step) {
  const timeoutMs = step.timeoutMs ?? 10000;
  const pollIntervalMs = step.pollIntervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  const portalMessages = new Set();
  let lastError = null;

  while (Date.now() <= deadline) {
    await collectPortalMessages(page, step, portalMessages);

    try {
      await page.locator(step.selector).first().waitFor({
        state: step.state ?? "visible",
        timeout: Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())),
      });
      await collectPortalMessages(page, step, portalMessages);
      return {
        found: true,
        portalMessages: [...portalMessages],
      };
    } catch (error) {
      lastError = error;
    }

    await collectPortalMessages(page, step, portalMessages);
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }

  return {
    found: false,
    error: lastError,
    portalMessages: [...portalMessages],
  };
}

async function collectPortalMessages(page, step, portalMessages) {
  const selectors = step.messageSelectors ?? [];

  for (const selector of selectors) {
    const texts = await page
      .locator(selector)
      .evaluateAll((elements) =>
        elements
          .filter((element) => {
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && (rect.width > 0 || rect.height > 0);
          })
          .map((element) => element.innerText || element.textContent || "")
          .map((text) => text.replace(/\s+/g, " ").trim())
          .filter(Boolean),
      )
      .catch(() => []);

    for (const text of texts) {
      portalMessages.add(text);
    }
  }
}

async function captureStopArtifacts(page, step, context, template) {
  if (step.captureArtifacts === false) {
    return {};
  }

  return captureStepArtifacts(page, {
    step,
    context,
    template,
    suffix: "safe-stop",
  });
}

async function captureStepArtifacts(page, { step, context, template, suffix }) {
  const configuredDir = step.artifactsDir ?? getPortalArtifactsDir();
  const outputDir = resolve(configuredDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const basename = `${safeFilePart(template.id)}-${safeFilePart(context.id)}-${stamp}-${suffix}`;
  const screenshotFile = `${basename}.png`;
  const htmlFile = `${basename}.html`;
  const screenshotPath = resolve(outputDir, screenshotFile);
  const htmlPath = resolve(outputDir, htmlFile);

  await mkdir(outputDir, { recursive: true });
  await page.screenshot({
    path: screenshotPath,
    fullPage: step.fullPageScreenshot ?? true,
  });
  await writeFile(htmlPath, await page.content(), "utf8");

  return {
    screenshotPath: displayArtifactPath(configuredDir, screenshotFile),
    htmlPath: displayArtifactPath(configuredDir, htmlFile),
    currentUrl: page.url(),
  };
}

function displayArtifactPath(directory, fileName) {
  const path = isAbsolute(directory) ? resolve(directory, fileName) : join(directory, fileName);
  return path.replaceAll("\\", "/");
}

function safeFilePart(value) {
  return String(value ?? "unknown")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function resolvePortalUrl(template, context = {}, step = {}) {
  if (shouldUsePortalFixture() && template.fixturePath) {
    return pathToFileURL(resolve(template.fixturePath)).href;
  }

  if (step.url) {
    return step.url;
  }

  if (step.urlFrom) {
    return readPath(context, step.urlFrom) ?? readPath(template, step.urlFrom);
  }

  return template.portalUrl;
}

function buildPortalNetworkPolicy() {
  const allowFile = shouldUsePortalFixture();
  return {
    allowFile,
    allowedFileRoots: allowFile ? [portalFixtureRoot] : [],
  };
}

async function safePageGoto(page, value, gotoOptions, networkPolicy) {
  const url = await assertSafeExternalUrl(value, networkPolicy);
  return page.goto(url.href, gotoOptions);
}

function readPath(source, path) {
  if (!path) {
    return undefined;
  }

  return path.split(".").reduce((current, key) => current?.[key], source);
}

async function afterActionWait(page, step) {
  if (step.waitForUrl) {
    await page.waitForURL(step.waitForUrl, {
      timeout: step.timeoutMs ?? 10000,
      waitUntil: step.waitUntil ?? "domcontentloaded",
    });
    return;
  }

  if (step.waitUntil) {
    await waitForPortalLoadState(page, step.waitUntil, step.timeoutMs ?? 10000, {
      step,
    });
  }
}

export async function waitForPortalLoadState(page, state, timeoutMs, metadata = {}) {
  const expectedState = String(state ?? "domcontentloaded").trim().toLowerCase();

  try {
    await page.waitForLoadState(expectedState, { timeout: timeoutMs });
    return { settled: true, settledWithEvidence: false };
  } catch (error) {
    if (!isLoadStateTimeout(error)) {
      throw error;
    }

    const evidence = await page
      .evaluate(() => ({
        readyState: document.readyState,
        hasBody: Boolean(document.body),
        url: window.location.href,
      }))
      .catch(() => null);

    if (!isCurrentDocumentSufficient(expectedState, evidence)) {
      throw error;
    }

    logger.info("Portal load wait settled from current document evidence.", {
      expectedState,
      timeoutMs,
      readyState: evidence.readyState,
      url: evidence.url,
      templateId: metadata.template?.id ?? null,
      jobId: metadata.context?.id ?? null,
      stepType: metadata.step?.type ?? null,
    });

    return { settled: true, settledWithEvidence: true, evidence };
  }
}

function isLoadStateTimeout(error) {
  return /timeout/i.test(String(error?.message ?? ""));
}

function isCurrentDocumentSufficient(expectedState, evidence) {
  if (!evidence?.hasBody) {
    return false;
  }

  if (expectedState === "domcontentloaded") {
    return ["interactive", "complete"].includes(evidence.readyState);
  }

  return evidence.readyState === "complete";
}

async function setElementValue(locator, rawValue, step) {
  const value = String(rawValue ?? "");
  await locator.waitFor({ state: "attached", timeout: step.timeoutMs ?? 10000 });
  await locator.evaluate((node, nextValue) => {
    const prototype =
      node instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : node instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : null;
    const setter = prototype ? Object.getOwnPropertyDescriptor(prototype, "value")?.set : null;

    if (setter) {
      setter.call(node, nextValue);
    } else {
      node.value = nextValue;
    }

    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
    node.dispatchEvent(new Event("blur", { bubbles: true }));
  }, value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
