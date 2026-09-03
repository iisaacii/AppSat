import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { chromium } from "playwright";
import { getPortalArtifactsDir } from "../../config/env.mjs";

const oxxoReprintUrl = "https://www4.oxxo.com:9443/facturacionElectronica-web/views/layout/reimpresionFactura.do";

export function shouldRecoverOxxoWithReprint({ template, templateResult }) {
  return (
    template?.portalFamily === "oxxo_real_validation" &&
    templateResult?.safeStop === true &&
    templateResult.reason === "cfdi_download_not_available"
  );
}

export function resolveOxxoReprintTicket(source) {
  const folio = source.folio ?? source.ocrCandidates?.folioVenta;
  const ticketId = source.ticketId ?? source.ocrCandidates?.ticketId ?? source.idVenta;
  const fecha = source.ticketDate ?? source.fecha ?? source.ocrCandidates?.fecha;
  const monto = source.monto ?? source.ocrCandidates?.monto;

  const missing = Object.entries({ folio, ticketId, fecha, monto })
    .filter(([, value]) => value === undefined || value === null || String(value).trim() === "")
    .map(([key]) => key);

  if (missing.length) {
    throw new Error(`Faltan datos de ticket para reimpresion OXXO: ${missing.join(", ")}`);
  }

  return {
    folio: String(folio).trim(),
    ticketId: String(ticketId).trim(),
    fecha: formatOxxoDate(fecha),
    monto: Number(monto).toFixed(2),
  };
}

export async function recoverOxxoCfdiByReprint({ job, template, context }) {
  const ticket = resolveOxxoReprintTicket({
    ...job,
    ...context,
  });
  const downloadResult = await downloadOxxoReprint({ job, template, ticket });

  return {
    downloadMode: "oxxo_reprint",
    xmlPath: downloadResult.downloads.xml.path,
    pdfPath: downloadResult.downloads.pdf.path,
    xmlDownloadFileName: downloadResult.downloads.xml.fileName,
    pdfDownloadFileName: downloadResult.downloads.pdf.fileName,
    xmlUrl: downloadResult.downloads.xml.url,
    pdfUrl: downloadResult.downloads.pdf.url,
    artifacts: downloadResult.artifacts,
    recovery: {
      type: "oxxo_reprint",
      ticket,
    },
  };
}

async function downloadOxxoReprint({ job, template, ticket }) {
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== "false",
  });
  const page = await browser.newPage({ acceptDownloads: true });
  const outputDir = resolve(getPortalArtifactsDir());
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = `oxxo-reprint-${safeFilePart(template?.id ?? "oxxo")}-${safeFilePart(job.id)}-${stamp}`;

  await mkdir(outputDir, { recursive: true });

  try {
    await page.goto(oxxoReprintUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

    await setInputValue(page, "#form\\:fecha_input", ticket.fecha);
    await page.locator("#form\\:folio").fill(ticket.folio, { timeout: 15000 });
    await page.locator("#form\\:venta").fill(ticket.ticketId, { timeout: 15000 });
    await page.locator("#form\\:total").fill(ticket.monto, { timeout: 15000 });
    await page.getByRole("button", { name: /Verificar/i }).click({ timeout: 15000 });

    const xmlButton = page.getByRole("button", { name: /Descargar XML/i });
    const pdfButton = page.getByRole("button", { name: /Descargar PDF/i });
    await pdfButton.waitFor({ state: "visible", timeout: 30000 });
    await xmlButton.waitFor({ state: "visible", timeout: 10000 });

    const artifacts = await captureArtifacts(page, outputDir, baseName);
    const xml = await captureDownload(page, xmlButton, outputDir, baseName, "xml");
    const pdf = await captureDownload(page, pdfButton, outputDir, baseName, "pdf");

    return {
      artifacts,
      downloads: { xml, pdf },
    };
  } catch (error) {
    const artifacts = await captureArtifacts(page, outputDir, `${baseName}-error`).catch(() => ({}));
    throw new Error(`No se pudo descargar por reimpresion OXXO: ${error.message}; artifacts=${JSON.stringify(artifacts)}`);
  } finally {
    await browser.close();
  }
}

function formatOxxoDate(value) {
  const raw = String(value ?? "").trim();
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);

  if (isoMatch) {
    return `${isoMatch[3]}/${isoMatch[2]}/${isoMatch[1]}`;
  }

  return raw;
}

async function setInputValue(page, selector, value) {
  const locator = page.locator(selector);
  await locator.waitFor({ state: "visible", timeout: 15000 });
  await locator.evaluate((element, nextValue) => {
    element.value = String(nextValue);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function captureArtifacts(page, outputDir, baseName) {
  const screenshotPath = resolve(outputDir, `${baseName}.png`);
  const htmlPath = resolve(outputDir, `${baseName}.html`);

  await page.screenshot({ path: screenshotPath, fullPage: true });
  await writeFile(htmlPath, await page.content(), "utf8");

  return { screenshotPath, htmlPath, currentUrl: page.url() };
}

async function captureDownload(page, locator, outputDir, baseName, kind) {
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }),
    locator.click({ timeout: 15000 }),
  ]);
  const suggested = sanitizeDownloadFileName(download.suggestedFilename(), kind);
  const targetPath = resolve(outputDir, `${baseName}-${kind}-${suggested}`);

  await download.saveAs(targetPath);

  return {
    path: targetPath,
    fileName: suggested,
    url: download.url(),
  };
}

function sanitizeDownloadFileName(value, kind) {
  const fallback = `cfdi.${kind}`;
  const name = basename(String(value ?? fallback))
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
  return name || fallback;
}

function safeFilePart(value) {
  return String(value ?? "unknown")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
