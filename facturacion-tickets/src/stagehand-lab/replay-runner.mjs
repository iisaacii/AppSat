import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { getPortalArtifactsDir, isStagehandFinalSubmitEnabled } from "../config/env.mjs";
import { selectBestOption } from "../shared/playwright-select-control.mjs";

export async function replayStagehandCache({ cache, context, job = {}, mode = "replay" }) {
  if (!cache?.actions?.length) {
    return {
      status: "needs_user_action",
      reason: "stagehand_cache_missing",
      statusMessage: "No hay cache Stagehand para reproducir",
      stagehandCacheStatus: "missing",
      aiNavigationResult: {
        providerMode: "stagehand",
        mode,
        reason: "stagehand_cache_missing",
      },
    };
  }

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== "false",
  });
  const page = await browser.newPage({
    acceptDownloads: true,
  });
  const executedActions = [];
  const failedActions = [];
  let result = null;

  try {
    for (const action of cache.actions) {
      try {
        const actionResult = await runCachedAction(page, action, context, job);
        executedActions.push({
          id: action.id,
          type: action.type,
          selector: action.selector ?? null,
          text: action.text ?? null,
          valueFrom: action.valueFrom ?? null,
          result: actionResult?.summary ?? null,
        });

        if (actionResult?.result) {
          result = actionResult.result;
        }

        if (actionResult?.result?.safeStop) {
          break;
        }
      } catch (error) {
        if (action.optional) {
          executedActions.push({
            id: action.id,
            type: action.type,
            selector: action.selector ?? null,
            text: action.text ?? null,
            valueFrom: action.valueFrom ?? null,
            result: "optional_skipped",
            error: error.message,
          });
          continue;
        }

        failedActions.push({
          id: action.id,
          type: action.type,
          selector: action.selector ?? null,
          text: action.text ?? null,
          error: error.message,
        });
        const artifacts = await captureStagehandArtifacts(page, {
          context,
          prefix: `${cache.key}-${mode}-failed`,
        }).catch(() => null);

        return {
          status: "needs_user_action",
          reason: "stagehand_replay_failed",
          statusMessage: `Replay Stagehand fallo en ${action.id ?? action.type}: ${error.message}`,
          stagehandCacheStatus: "failed",
          stagehandTrace: {
            mode,
            executedActions,
            failedActions,
          },
          aiNavigationResult: {
            providerMode: "stagehand",
            mode,
            status: "needs_user_action",
            reason: "stagehand_replay_failed",
            executedActions,
            failedActions,
            artifacts,
          },
          artifacts,
        };
      }
    }

    const artifacts = await captureStagehandArtifacts(page, {
      context,
      prefix: `${cache.key}-${mode}-completed`,
    }).catch(() => null);

    return {
      ...(result ?? {}),
      status: result?.xmlPath && result?.pdfPath ? "completed" : (result?.status ?? "needs_user_action"),
      reason: result?.reason ?? (result?.xmlPath && result?.pdfPath ? "stagehand_cache_downloaded_cfdi" : "stagehand_replay_ready"),
      statusMessage:
        result?.statusMessage ??
        (result?.xmlPath && result?.pdfPath
          ? "CFDI descargado por cache Stagehand"
          : "Replay Stagehand llego al punto seguro"),
      stagehandCacheStatus: "replayed",
      stagehandTrace: {
        mode,
        executedActions,
        failedActions,
      },
      aiNavigationResult: {
        providerMode: "stagehand",
        mode,
        status: result?.xmlPath && result?.pdfPath ? "completed" : "needs_user_action",
        reason: result?.reason ?? "stagehand_replay_ready",
        executedActions,
        failedActions,
        artifacts,
      },
      artifacts,
    };
  } finally {
    await browser.close();
  }
}

async function runCachedAction(page, action, context, job) {
  if (action.type === "goto") {
    await page.goto(resolveValue(action.url ?? action.valueFrom, context) ?? context.portalUrl, {
      waitUntil: action.waitUntil ?? "domcontentloaded",
      timeout: action.timeoutMs ?? 30000,
    });
    return { summary: page.url() };
  }

  if (action.type === "fill") {
    await page.locator(action.selector).first().fill(String(resolveValue(action.valueFrom ?? action.value, context) ?? ""), {
      timeout: action.timeoutMs ?? 10000,
    });
    await afterActionWait(page, action);
    return null;
  }

  if (action.type === "fillFirstVisible") {
    await fillFirstVisible(page, action, resolveValue(action.valueFrom ?? action.value, context));
    await afterActionWait(page, action);
    return null;
  }

  if (action.type === "select") {
    await selectBestOption(
      page,
      page.locator(action.selector),
      resolveValue(action.valueFrom ?? action.value, context),
      action,
    );
    await afterActionWait(page, action);
    return null;
  }

  if (action.type === "check") {
    await page.locator(action.selector).first().setChecked(action.checked ?? true, {
      timeout: action.timeoutMs ?? 10000,
    });
    await afterActionWait(page, action);
    return null;
  }

  if (action.type === "click") {
    await page.locator(action.selector).first().click({ timeout: action.timeoutMs ?? 10000 });
    await afterActionWait(page, action);
    return null;
  }

  if (action.type === "clickFirstVisible") {
    await clickFirstVisible(page, action);
    await afterActionWait(page, action);
    return null;
  }

  if (action.type === "clickText") {
    await page.getByText(String(action.text ?? resolveValue(action.textFrom, context) ?? ""), {
      exact: action.exact ?? false,
    }).click({ timeout: action.timeoutMs ?? 10000 });
    await afterActionWait(page, action);
    return null;
  }

  if (action.type === "waitForSelector") {
    await page.locator(action.selector).first().waitFor({
      state: action.state ?? "visible",
      timeout: action.timeoutMs ?? 10000,
    });
    return null;
  }

  if (action.type === "waitForEnabled") {
    await waitForEnabled(page, action.selector, action.timeoutMs ?? 10000);
    return null;
  }

  if (action.type === "waitForText") {
    await page.getByText(String(action.text ?? resolveValue(action.textFrom, context) ?? ""), {
      exact: action.exact ?? false,
    }).waitFor({
      state: "visible",
      timeout: action.timeoutMs ?? 10000,
    });
    return null;
  }

  if (action.type === "finalSubmit") {
    const finalSubmitGuard = buildStagehandFinalSubmitGuard(job, action);

    if (!finalSubmitGuard.ready) {
      const artifacts = await captureStagehandArtifacts(page, {
        context,
        prefix: `${context.id ?? "job"}-stagehand-final-guard`,
      }).catch(() => null);

      return {
        result: {
          status: "needs_user_action",
          reason: "stagehand_final_submit_approval_required",
          statusMessage: "Stagehand se detuvo antes de emitir por guardas de aprobacion",
          safeStop: true,
          finalSubmitGuard,
          artifacts,
        },
      };
    }

    await page.locator(action.selector).first().click({ timeout: action.timeoutMs ?? 10000 });
    await afterActionWait(page, action);
    return null;
  }

  if (action.type === "download") {
    const downloads = await captureCfdiDownloads(page, action, context);

    return {
      result: {
        ...downloads,
        status: downloads.xmlPath && downloads.pdfPath ? "completed" : "needs_user_action",
        reason: downloads.xmlPath && downloads.pdfPath ? "stagehand_cache_downloaded_cfdi" : "stagehand_download_incomplete",
        statusMessage:
          downloads.xmlPath && downloads.pdfPath
            ? "CFDI descargado por cache Stagehand"
            : "Stagehand no pudo descargar XML/PDF completos",
      },
    };
  }

  if (action.type === "act" || action.type === "observe") {
    return null;
  }

  throw new Error(`Unsupported Stagehand cache action type: ${action.type}`);
}

async function fillFirstVisible(page, action, value) {
  const candidate = await findFirstVisibleEnabled(page, action.selector, {
    timeoutMs: action.timeoutMs ?? 10000,
    maxMatches: action.maxMatches,
  });
  await candidate.fill(String(value ?? ""), {
    timeout: action.timeoutMs ?? 10000,
  });
}

async function clickFirstVisible(page, action) {
  const candidate = await findFirstVisibleEnabled(page, action.selector, {
    timeoutMs: action.timeoutMs ?? 10000,
    maxMatches: action.maxMatches,
  });
  await candidate.click({ timeout: action.timeoutMs ?? 10000 });
}

async function waitForEnabled(page, selector, timeoutMs) {
  await findFirstVisibleEnabled(page, selector, { timeoutMs });
}

async function findFirstVisibleEnabled(page, selector, { timeoutMs = 10000, maxMatches = 25 } = {}) {
  const startedAt = Date.now();
  let lastState = "not_checked";

  while (Date.now() - startedAt < timeoutMs) {
    const locator = page.locator(selector);
    const count = Math.min(await locator.count().catch(() => 0), maxMatches);

    if (!count) {
      lastState = "no_matches";
    }

    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      const [visible, enabled] = await Promise.all([
        candidate.isVisible({ timeout: 300 }).catch(() => false),
        candidate.isEnabled({ timeout: 300 }).catch(() => false),
      ]);

      if (visible && enabled) {
        return candidate;
      }

      lastState = visible ? "visible_disabled" : "not_visible";
    }

    await page.waitForTimeout(500);
  }

  throw new Error(`Timed out waiting for visible enabled selector ${selector}; lastState=${lastState}`);
}

function buildStagehandFinalSubmitGuard(job, action) {
  const checks = {
    actionAllowsFinalSubmit: action.allowSubmit === true,
    workerAllowsFinalSubmit: isStagehandFinalSubmitEnabled(),
    jobApprovedFinalSubmit: job.portalFinalSubmitApproved === true,
  };
  const blockedBy = [];

  if (!checks.actionAllowsFinalSubmit) blockedBy.push("stagehand_action_allow_submit_false");
  if (!checks.workerAllowsFinalSubmit) blockedBy.push("stagehand_worker_allow_submit_false");
  if (!checks.jobApprovedFinalSubmit) blockedBy.push("job_final_submit_not_approved");

  return {
    ready: blockedBy.length === 0,
    blockedBy,
    ...checks,
  };
}

async function captureCfdiDownloads(page, action, context) {
  const outputDir = resolve(action.downloadsDir ?? getPortalArtifactsDir());
  await mkdir(outputDir, { recursive: true });
  const result = {
    downloadMode: "stagehand_cache",
    downloadErrors: [],
  };

  for (const kind of ["xml", "pdf"]) {
    const selector = kind === "xml" ? action.xmlSelector : action.pdfSelector;

    if (!selector) {
      result.downloadErrors.push({ kind, error: "selector missing" });
      continue;
    }

    const locator = page.locator(selector).first();

    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: action.downloadTimeoutMs ?? action.timeoutMs ?? 30000 }),
        locator.click({ timeout: action.timeoutMs ?? 10000 }),
      ]);
      const suggested = sanitizeDownloadFileName(download.suggestedFilename?.() ?? `cfdi.${kind}`, kind);
      const fileName = `${safeFilePart(context.id ?? "job")}-${Date.now()}-${kind}-${suggested}`;
      const outputPath = resolve(outputDir, fileName);
      await download.saveAs(outputPath);
      result[`${kind}Path`] = displayArtifactPath(action.downloadsDir ?? getPortalArtifactsDir(), fileName);
      result[`${kind}DownloadFileName`] = suggested;
      result[`${kind}Url`] = typeof download.url === "function" ? download.url() : null;
    } catch (error) {
      result.downloadErrors.push({ kind, error: error.message });
    }
  }

  return result;
}

export async function captureStagehandArtifacts(page, { context, prefix }) {
  const directory = getPortalArtifactsDir();
  const outputDir = resolve(directory);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const basename = `${safeFilePart(prefix)}-${safeFilePart(context.id ?? "job")}-${stamp}`;
  const screenshotFile = `${basename}.png`;
  const htmlFile = `${basename}.html`;

  await mkdir(outputDir, { recursive: true });
  const screenshotBuffer = await page.screenshot({ fullPage: true }).catch(() => null);

  if (screenshotBuffer) {
    await writeFile(resolve(outputDir, screenshotFile), screenshotBuffer);
  } else {
    await page.screenshot({ path: resolve(outputDir, screenshotFile), fullPage: true }).catch(() => {});
  }

  const html =
    typeof page.content === "function"
      ? await page.content()
      : await page.evaluate(() => document.documentElement.outerHTML);
  await writeFile(resolve(outputDir, htmlFile), html, "utf8");

  return {
    screenshotPath: displayArtifactPath(directory, screenshotFile),
    htmlPath: displayArtifactPath(directory, htmlFile),
    currentUrl: page.url(),
  };
}

async function afterActionWait(page, action) {
  if (action.waitForUrl) {
    await page.waitForURL(action.waitForUrl, {
      timeout: action.timeoutMs ?? 10000,
      waitUntil: action.waitUntil ?? "domcontentloaded",
    });
    return;
  }

  if (action.waitForSelector) {
    await page.locator(action.waitForSelector).first().waitFor({
      state: action.state ?? "visible",
      timeout: action.timeoutMs ?? 10000,
    });
  }

  if (action.waitUntil) {
    await page.waitForLoadState(action.waitUntil, { timeout: action.timeoutMs ?? 10000 }).catch(() => {});
  }

  if (action.waitMs) {
    await page.waitForTimeout(action.waitMs);
  }
}

function resolveValue(pathOrValue, context) {
  if (!pathOrValue || typeof pathOrValue !== "string") {
    return pathOrValue;
  }

  if (!pathOrValue.includes(".") && Object.prototype.hasOwnProperty.call(context, pathOrValue)) {
    return context[pathOrValue];
  }

  return pathOrValue.split(".").reduce((current, key) => current?.[key], context) ?? pathOrValue;
}

function displayArtifactPath(directory, fileName) {
  const path = isAbsolute(directory) ? resolve(directory, fileName) : join(directory, fileName);
  return path.replaceAll("\\", "/");
}

function sanitizeDownloadFileName(value, kind) {
  const fallback = `cfdi.${kind}`;
  const fileName = String(value ?? fallback)
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");

  return fileName || fallback;
}

function safeFilePart(value) {
  return String(value ?? "unknown")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
