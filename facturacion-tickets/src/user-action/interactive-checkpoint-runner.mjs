import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { selectBestOption } from "../shared/playwright-select-control.mjs";
import { resolveTemplateFields } from "../portals/template-fields.mjs";
import {
  assertSafeExternalUrl,
  installSafePageNetworkGuard,
} from "../security/external-url-policy.mjs";

const finalSubmitLabels = [
  "FACTURAR",
  "Facturar",
  "Generar factura",
  "Generar Factura",
  "Emitir factura",
  "Emitir",
  "Continuar",
  "Enviar",
];
const serviceRootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const portalFixtureRoot = resolve(serviceRootDir, "src/portals/fixtures");

export async function runInteractiveCheckpoint({
  checkpoint,
  template = null,
  fixture = {},
  taxProfile = {},
  approveFinalSubmit = true,
  headless = false,
  autoSubmitAfterUser = true,
  waitForUser = true,
  keepBrowserOpen = false,
  useFixture = false,
  outputDir = "artifacts/user-action/interactive-runs",
  runId = null,
} = {}) {
  const { chromium } = await import("playwright");
  const id = safeFilePart(runId ?? fixture.id ?? checkpoint?.jobId ?? `interactive_${Date.now()}`);
  const runDir = resolve(outputDir, `${id}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const downloadsDir = join(runDir, "downloads");
  await mkdir(downloadsDir, { recursive: true });

  const downloads = [];
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const networkPolicy = buildInteractiveNetworkPolicy(useFixture);
  await installSafePageNetworkGuard(page, networkPolicy);
  page.on("download", async (download) => {
    const suggested = sanitizeDownloadName(download.suggestedFilename?.() ?? "download.bin");
    const path = join(downloadsDir, `${Date.now()}-${suggested}`);
    await download.saveAs(path);
    downloads.push({
      path: displayPath(path),
      fileName: suggested,
      url: typeof download.url === "function" ? download.url() : null,
    });
  });

  const executedSteps = [];
  let stoppedAt = null;
  let result;

  try {
    const contextData = buildContextData({ fixture, taxProfile, checkpoint, approveFinalSubmit });
    const resolvedTemplate = template ? resolveTemplateForRun(template, contextData) : null;

    if (resolvedTemplate) {
      stoppedAt = await replayTemplateUntilCheckpoint({
        page,
        template: resolvedTemplate.template,
        contextData: {
          ...contextData,
          ...resolvedTemplate.fields,
        },
        executedSteps,
        useFixture,
      });
    } else {
      await safePageGoto(page, checkpoint?.currentUrl ?? checkpoint?.portalUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      }, networkPolicy);
      stoppedAt = {
        reason: checkpoint?.reason ?? "manual_portal_required",
        statusMessage: "Checkpoint abierto para asistencia manual.",
        step: null,
      };
    }

    const taxAutofill = await fillRemainingVisibleTaxFields(page, taxProfile);
    const beforeUserArtifacts = await captureArtifacts(page, runDir, "before-user-action");

    if (waitForUser) {
      await promptUserToContinue({
        stoppedAt,
        page,
        autoSubmitAfterUser,
      });
    }

    if (autoSubmitAfterUser) {
      await tryAutoSubmitAfterUser(page);
    }

    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await tryDownloadVisibleCfdiLinks(page);
    await page.waitForTimeout(1500);

    const afterUserArtifacts = await captureArtifacts(page, runDir, "after-user-action");
    const downloadedFiles = await collectDownloadedFiles(downloadsDir, downloads);
    const xml = downloadedFiles.find((file) => file.kind === "xml") ?? null;
    const pdf = downloadedFiles.find((file) => file.kind === "pdf") ?? null;

    result = {
      ok: true,
      status: xml && pdf ? "completed" : "needs_user_action",
      reason: xml && pdf ? "interactive_cfdi_downloaded" : "interactive_checkpoint_pending",
      statusMessage:
        xml && pdf
          ? "Sesion asistida completada; XML y PDF descargados."
          : "Sesion asistida abierta/capturada; aun no se detectaron XML y PDF.",
      currentUrl: page.url(),
      runDir: displayPath(runDir),
      downloadsDir: displayPath(downloadsDir),
      downloadedXml: Boolean(xml),
      downloadedPdf: Boolean(pdf),
      resultXmlPath: xml?.path ?? null,
      resultPdfPath: pdf?.path ?? null,
      downloads: downloadedFiles,
      stoppedAt,
      executedSteps,
      taxAutofill,
      artifacts: {
        beforeUser: beforeUserArtifacts,
        afterUser: afterUserArtifacts,
      },
    };

    await writeFile(join(runDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return result;
  } catch (error) {
    const failure = {
      ok: false,
      status: "failed",
      reason: "interactive_checkpoint_failed",
      statusMessage: error.message,
      runDir: displayPath(runDir),
      currentUrl: page.url?.() ?? null,
      stoppedAt,
      executedSteps,
    };
    await writeFile(join(runDir, "result.json"), `${JSON.stringify(failure, null, 2)}\n`, "utf8").catch(() => {});
    return failure;
  } finally {
    if (keepBrowserOpen || process.env.CAPA_C_KEEP_BROWSER_OPEN === "true") {
      // Useful while debugging a portal manually.
    } else {
      await browser.close();
    }
  }
}

function buildContextData({ fixture, taxProfile, checkpoint, approveFinalSubmit }) {
  const ticketData = checkpoint?.ticketData ?? {};
  return {
    ...fixture,
    ...(fixture.ocrCandidates ?? {}),
    ...ticketData,
    ocrCandidates: {
      ...(fixture.ocrCandidates ?? {}),
      ...(ticketData.codigoFacturacion ? { codigoFacturacion: ticketData.codigoFacturacion } : {}),
      ...(ticketData.sucursal ? { sucursal: ticketData.sucursal } : {}),
    },
    taxProfile,
    id: fixture.id ?? "interactive_checkpoint",
    portalFinalSubmitApproved: approveFinalSubmit,
  };
}

function resolveTemplateForRun(template, contextData) {
  const resolution = resolveTemplateFields(template, contextData);
  if (resolution.missingFields.length) {
    throw new Error(`Missing fields for interactive replay: ${resolution.missingFields.map((field) => field.name).join(", ")}`);
  }
  return {
    template,
    fields: resolution.resolved,
  };
}

async function replayTemplateUntilCheckpoint({ page, template, contextData, executedSteps, useFixture }) {
  for (const step of template.steps ?? []) {
    executedSteps.push({
      type: step.type,
      selector: step.selector ?? null,
      text: step.text ?? null,
      valueFrom: step.valueFrom ?? null,
    });

    if (step.type === "stop") {
      return {
        reason: step.reason ?? "template_safe_stop",
        statusMessage: step.message ?? "Template detenido para intervencion del usuario.",
        step,
      };
    }

    await runInteractiveStep(page, step, contextData, template, useFixture);
  }

  return {
    reason: "template_completed_without_checkpoint",
    statusMessage: "Template ejecutado sin punto de pausa.",
    step: null,
  };
}

async function runInteractiveStep(page, step, contextData, template, useFixture = false) {
  const timeout = step.timeoutMs ?? 10000;

  if (step.type === "goto") {
    await safePageGoto(page, resolveStepUrl(step, template, contextData, useFixture), {
      waitUntil: step.waitUntil ?? "domcontentloaded",
      timeout,
    }, buildInteractiveNetworkPolicy(useFixture));
    return;
  }

  if (step.type === "waitForLoadState") {
    await page.waitForLoadState(step.state ?? "domcontentloaded", { timeout }).catch(() => {});
    return;
  }

  if (step.type === "waitForSelector") {
    await page.locator(step.selector).first().waitFor({ state: step.state ?? "visible", timeout });
    return;
  }

  if (step.type === "fill") {
    await page.locator(step.selector).fill(String(readPath(contextData, step.valueFrom) ?? ""), { timeout });
    return;
  }

  if (step.type === "setValue") {
    await page.locator(step.selector).evaluate(
      (element, value) => {
        element.value = value ?? "";
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      },
      String(readPath(contextData, step.valueFrom) ?? ""),
    );
    return;
  }

  if (step.type === "select" || step.type === "selectOrStop") {
    await selectBestOption(page, page.locator(step.selector), readPath(contextData, step.valueFrom), step);
    return;
  }

  if (step.type === "check") {
    await page.locator(step.selector).setChecked(step.checked ?? true, { timeout });
    return;
  }

  if (step.type === "click") {
    await page.locator(step.selector).click({ timeout });
    await afterActionWait(page, step);
    return;
  }

  if (step.type === "dispatchClick") {
    const locator = page.locator(step.selector);
    await locator.waitFor({ state: "attached", timeout });
    await locator.dispatchEvent("click");
    await afterActionWait(page, step);
    return;
  }

  if (step.type === "clickText") {
    await page.getByText(String(step.text ?? readPath(contextData, step.textFrom) ?? ""), {
      exact: step.exact ?? false,
    }).click({ timeout });
    await afterActionWait(page, step);
    return;
  }

  if (step.type === "finalSubmit") {
    await page.locator(step.selector).click({ timeout });
    await afterActionWait(page, step);
    return;
  }

  if (step.optional) {
    return;
  }

  throw new Error(`Unsupported interactive checkpoint step type: ${step.type}`);
}

async function promptUserToContinue({ stoppedAt, page, autoSubmitAfterUser }) {
  const rl = createInterface({ input, output });
  const action =
    autoSubmitAfterUser
      ? "Resuelve el CAPTCHA o bloqueo humano en el navegador. Cuando termines, presiona Enter aqui; intentaré continuar/descargar."
      : "Resuelve el CAPTCHA o bloqueo humano y descarga XML/PDF si aparecen. Cuando termines, presiona Enter aqui.";

  await rl.question(
    [
      "",
      "Capa C: sesion asistida lista.",
      `Motivo: ${stoppedAt?.reason ?? "manual_checkpoint"}`,
      `URL actual: ${page.url()}`,
      action,
      "",
    ].join("\n"),
  );
  rl.close();
}

async function fillRemainingVisibleTaxFields(page, taxProfile = {}) {
  const fields = [
    {
      key: "street",
      value: taxProfile.street,
      selectors: ["#basicForm #calle", "input[name='calle']", "input[id='calle']"],
      labels: [/calle/i],
    },
    {
      key: "exteriorNumber",
      value: taxProfile.exteriorNumber,
      selectors: ["#basicForm #noExterior", "#basicForm #numExterior", "input[name='noExterior']", "input[name='numExterior']"],
      labels: [/n[uú]mero\s+exterior/i, /\bno\.?\s*exterior/i],
    },
    {
      key: "interiorNumber",
      value: taxProfile.interiorNumber,
      selectors: ["#basicForm #noInterior", "#basicForm #numInterior", "input[name='noInterior']", "input[name='numInterior']"],
      labels: [/n[uú]mero\s+interior/i, /\bno\.?\s*interior/i],
    },
    {
      key: "neighborhood",
      value: taxProfile.neighborhood,
      selectors: ["#basicForm #colonia", "input[name='colonia']", "input[id='colonia']"],
      labels: [/colonia/i],
    },
    {
      key: "municipality",
      value: taxProfile.municipality,
      selectors: ["#basicForm #delegacion", "input[name='delegacion']", "input[id='delegacion']"],
      labels: [/delegaci[oó]n/i, /municipio/i, /\bmpio/i],
    },
    {
      key: "city",
      value: taxProfile.city ?? taxProfile.municipality,
      selectors: ["#basicForm #ciudad", "input[name='ciudad']", "input[id='ciudad']"],
      labels: [/ciudad/i],
    },
    {
      key: "state",
      value: taxProfile.state,
      selectors: ["#basicForm #estado", "input[name='estado']", "select[name='estado']"],
      labels: [/estado/i],
    },
    {
      key: "country",
      value: taxProfile.country,
      selectors: ["#basicForm #pais", "input[name='pais']", "input[id='pais']"],
      labels: [/pa[ií]s/i],
    },
    {
      key: "postalCode",
      value: taxProfile.postalCode,
      selectors: ["#basicForm #cp", "#basicForm #codigoPostal", "input[name='cp']", "input[name='codigoPostal']"],
      labels: [/\bcp\b/i, /c[oó]digo\s+postal/i],
    },
    {
      key: "email",
      value: taxProfile.email,
      selectors: ["#basicForm #emailInput", "input[name='emailInput']", "input[type='email']"],
      labels: [/correo/i, /email/i],
    },
  ];
  const filled = [];

  for (const field of fields) {
    if (!field.value) {
      continue;
    }

    const didFill = await fillFirstVisibleEmptyField(page, field).catch(() => false);
    if (didFill) {
      filled.push(field.key);
    }
  }

  return {
    filled,
  };
}

async function fillFirstVisibleEmptyField(page, field) {
  for (const selector of field.selectors) {
    const locator = page.locator(selector);
    const count = Math.min(await locator.count().catch(() => 0), 5);

    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      if (!(await isVisibleAndEnabled(item))) {
        continue;
      }
      const current = await item.inputValue().catch(() => "");
      if (String(current ?? "").trim()) {
        continue;
      }

      await fillControl(page, item, field.value);
      return true;
    }
  }

  return fillByLabelText(page, field);
}

async function fillByLabelText(page, field) {
  const candidates = await page
    .locator("label")
    .evaluateAll((labels) =>
      labels.map((label, index) => ({
        index,
        text: (label.innerText || label.textContent || "").replace(/\s+/g, " ").trim(),
        forId: label.getAttribute("for") || "",
      })),
    )
    .catch(() => []);

  for (const candidate of candidates) {
    if (!field.labels.some((pattern) => pattern.test(candidate.text))) {
      continue;
    }

    const selectors = [
      candidate.forId ? `#${cssEscape(candidate.forId)}` : null,
      `label:nth-of-type(${candidate.index + 1}) + input`,
      `label:nth-of-type(${candidate.index + 1}) ~ input`,
    ].filter(Boolean);

    for (const selector of selectors) {
      const item = page.locator(selector).first();
      if (await isVisibleAndEnabled(item)) {
        const current = await item.inputValue().catch(() => "");
        if (!String(current ?? "").trim()) {
          await fillControl(page, item, field.value);
          return true;
        }
      }
    }
  }

  return false;
}

async function fillControl(page, locator, value) {
  const tagName = await locator.evaluate((element) => element.tagName.toLowerCase()).catch(() => "");
  if (tagName === "select") {
    await selectBestOption(page, locator, value, { timeoutMs: 8000 }).catch(async () => {
      await locator.selectOption(String(value));
    });
    return;
  }

  await locator.fill(String(value), { timeout: 8000 }).catch(async () => {
    await locator.evaluate((element, nextValue) => {
      element.value = nextValue ?? "";
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }, String(value));
  });
}

async function tryAutoSubmitAfterUser(page) {
  for (const label of finalSubmitLabels) {
    const locator = page.getByRole("button", { name: new RegExp(`^\\s*${escapeRegExp(label)}\\s*$`, "i") });
    if ((await locator.count().catch(() => 0)) > 0) {
      const first = locator.first();
      if (await isVisibleAndEnabled(first)) {
        await first.click({ timeout: 5000 }).catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
        return;
      }
    }
  }

  for (const label of finalSubmitLabels) {
    const locator = page.getByText(label, { exact: false });
    if ((await locator.count().catch(() => 0)) > 0) {
      const first = locator.first();
      if (await isVisibleAndEnabled(first)) {
        await first.click({ timeout: 5000 }).catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
        return;
      }
    }
  }
}

async function tryDownloadVisibleCfdiLinks(page) {
  const patterns = [/xml/i, /pdf/i, /descargar/i, /download/i];
  for (const pattern of patterns) {
    const locator = page.getByText(pattern, { exact: false });
    const count = Math.min(await locator.count().catch(() => 0), 4);
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      if (await isVisibleAndEnabled(item)) {
        await item.click({ timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(800);
      }
    }
  }
}

async function isVisibleAndEnabled(locator) {
  return (await locator.isVisible().catch(() => false)) && (await locator.isEnabled().catch(() => true));
}

async function afterActionWait(page, step) {
  if (step.waitUntil) {
    await page.waitForLoadState(step.waitUntil, { timeout: step.afterClickTimeoutMs ?? 10000 }).catch(() => {});
  }
  if (step.waitMs) {
    await page.waitForTimeout(step.waitMs);
  } else {
    await page.waitForTimeout(400);
  }
}

async function captureArtifacts(page, runDir, suffix) {
  await mkdir(runDir, { recursive: true });
  const screenshotPath = join(runDir, `${suffix}.png`);
  const htmlPath = join(runDir, `${suffix}.html`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  await writeFile(htmlPath, await page.content().catch(() => ""), "utf8").catch(() => {});
  return {
    screenshotPath: displayPath(screenshotPath),
    htmlPath: displayPath(htmlPath),
    currentUrl: page.url(),
  };
}

async function collectDownloadedFiles(downloadsDir, observedDownloads) {
  const observed = new Map(observedDownloads.map((item) => [resolve(item.path), item]));
  const entries = await readdir(downloadsDir).catch(() => []);
  const files = [];

  for (const entry of entries) {
    const path = join(downloadsDir, entry);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) {
      continue;
    }
    const extension = extname(entry).toLowerCase();
    files.push({
      path: displayPath(path),
      fileName: observed.get(resolve(path))?.fileName ?? basename(entry),
      kind: extension === ".xml" ? "xml" : extension === ".pdf" ? "pdf" : "other",
      size: info.size,
    });
  }

  return files;
}

function resolveStepUrl(step, template, contextData, useFixture = false) {
  if ((useFixture || process.env.CAPA_C_USE_FIXTURE === "true") && template.fixturePath) {
    const fixturePath = isAbsolute(template.fixturePath)
      ? template.fixturePath
      : resolve(serviceRootDir, template.fixturePath);
    return pathToFileURL(fixturePath).href;
  }
  if (step.url) {
    return step.url;
  }
  if (step.urlFrom) {
    return readPath(contextData, step.urlFrom) ?? readPath(template, step.urlFrom);
  }
  if (template.portalUrl) {
    return template.portalUrl;
  }
  const fallback = contextData.portalUrl ?? contextData.portalCandidateUrl;
  return isAbsolute(fallback) ? pathToFileURL(fallback).href : fallback;
}

function buildInteractiveNetworkPolicy(useFixture = false) {
  const allowFile = useFixture || process.env.CAPA_C_USE_FIXTURE === "true";
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

function sanitizeDownloadName(value) {
  return String(value ?? "download.bin")
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function safeFilePart(value) {
  return String(value ?? "unknown")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function displayPath(path) {
  return resolve(path).replaceAll("\\", "/");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cssEscape(value) {
  return String(value).replace(/["\\#.:,[\]>+~*^$|=]/g, "\\$&");
}
