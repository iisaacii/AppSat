import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { findPortalTemplateByRfc } from "../portals/portal-registry.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const artifactsDir = resolve(rootDir, "artifacts/portal-probes");
const runStamp = new Date().toISOString().replace(/[^0-9]/g, "");
const rfc = getCliOption("rfc") ?? "CCO8605231N4";
const useFixture = getCliOption("fixture") === "true";
const followFacturacion = getCliOption("follow-facturacion") !== "false";
const explicitUrl = getCliOption("url");
const template = await findPortalTemplateByRfc(rfc);

if (!template) {
  throw new Error(`Template not found for RFC ${rfc}.`);
}

const { chromium } = await import("playwright");
const browser = await chromium.launch({
  headless: process.env.HEADLESS !== "false",
});

try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const targetUrl = resolveProbeUrl(template, explicitUrl, useFixture);
  const result = {
    templateId: template.id,
    rfcEmisor: template.rfcEmisor,
    targetUrl,
    snapshots: [],
  };

  await page.goto(targetUrl, {
    waitUntil: "domcontentloaded",
    timeout: Number(getCliOption("timeout-ms") ?? 45000),
  });
  result.snapshots.push(await captureSnapshot(page, "initial"));

  if (followFacturacion) {
    const clickResult = await clickFacturacionLink(page);
    result.followFacturacion = clickResult;

    if (clickResult.clicked) {
      result.snapshots.push(await captureSnapshot(page, "after_facturacion_click"));
    }
  }

  const reportPath = resolve(artifactsDir, `${template.id}_report_${runStamp}.json`);
  await writeFile(reportPath, JSON.stringify(result, null, 2), "utf8");

  console.log(JSON.stringify(buildSummary(result, reportPath), null, 2));
} finally {
  await browser.close();
}

async function captureSnapshot(page, label) {
  await mkdir(artifactsDir, { recursive: true });
  const safeLabel = label.replace(/[^a-z0-9_-]/gi, "_");
  const screenshotPath = resolve(
    artifactsDir,
    `${template.id}_${safeLabel}_${runStamp}.png`,
  );
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const dom = await page.evaluate(() => {
    const textOf = (node) => (node?.innerText ?? node?.textContent ?? "").replace(/\s+/g, " ").trim();
    const attr = (node, name) => node.getAttribute(name) ?? null;

    return {
      title: document.title,
      url: location.href,
      hasCaptcha:
        Boolean(document.querySelector(".g-recaptcha, [data-sitekey]")) ||
        [...document.querySelectorAll("iframe, script")].some((node) =>
          /captcha|recaptcha|hcaptcha/i.test(node.getAttribute("src") ?? ""),
        ),
      inputs: [...document.querySelectorAll("input, select, textarea")].slice(0, 80).map((node) => ({
        tag: node.tagName.toLowerCase(),
        type: attr(node, "type"),
        name: attr(node, "name"),
        id: attr(node, "id"),
        placeholder: attr(node, "placeholder"),
        ariaLabel: attr(node, "aria-label"),
        label: findLabelText(node),
        options:
          node instanceof HTMLSelectElement
            ? [...node.options].slice(0, 80).map((option) => ({
                value: option.value,
                text: textOf(option),
                selected: option.selected,
              }))
            : undefined,
      })),
      buttons: [...document.querySelectorAll("button, input[type='button'], input[type='submit']")]
        .slice(0, 40)
        .map((node) => ({
          tag: node.tagName.toLowerCase(),
          type: attr(node, "type"),
          id: attr(node, "id"),
          text: textOf(node) || attr(node, "value"),
        })),
      facturaLinks: [...document.querySelectorAll("a, button")]
        .filter((node) => /facturaci[oó]n|factura|cfdi/i.test(textOf(node)))
        .slice(0, 20)
        .map((node) => ({
          tag: node.tagName.toLowerCase(),
          text: textOf(node),
          href: attr(node, "href"),
        })),
      bodyTextPreview: textOf(document.body).slice(0, 1200),
    };

    function findLabelText(node) {
      const id = node.getAttribute("id");

      if (id) {
        const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (label) return textOf(label);
      }

      return textOf(node.closest("label") ?? null);
    }
  });

  return {
    label,
    screenshotPath,
    ...dom,
  };
}

function buildSummary(result, reportPath) {
  return {
    templateId: result.templateId,
    rfcEmisor: result.rfcEmisor,
    targetUrl: result.targetUrl,
    reportPath,
    snapshots: result.snapshots.map((snapshot) => ({
      label: snapshot.label,
      url: snapshot.url,
      title: snapshot.title,
      hasCaptcha: snapshot.hasCaptcha,
      screenshotPath: snapshot.screenshotPath,
      inputCount: snapshot.inputs.length,
      buttonCount: snapshot.buttons.length,
      selects: snapshot.inputs
        .filter((input) => input.tag === "select")
        .map((select) => ({
          id: select.id,
          name: select.name,
          optionCount: select.options?.length ?? 0,
          sampleOptions: select.options?.slice(0, 8) ?? [],
        })),
      buttons: snapshot.buttons,
      facturaLinks: snapshot.facturaLinks,
    })),
    followFacturacion: result.followFacturacion,
  };
}

async function clickFacturacionLink(page) {
  const locator = page.locator("a, button").filter({ hasText: /facturaci[oó]n|factura|cfdi/i }).first();

  try {
    await locator.waitFor({ state: "visible", timeout: 5000 });
    const text = await locator.innerText().catch(() => "");
    await locator.click({ timeout: 5000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    return {
      clicked: true,
      text: text.replace(/\s+/g, " ").trim(),
      urlAfterClick: page.url(),
    };
  } catch (error) {
    return {
      clicked: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function resolveProbeUrl(template, url, fixture) {
  if (url) {
    return url;
  }

  if (fixture && template.fixturePath) {
    return pathToFileURL(resolve(template.fixturePath)).href;
  }

  return template.portalUrl;
}

function getCliOption(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}
