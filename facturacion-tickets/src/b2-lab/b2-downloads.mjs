import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { getPortalArtifactsDir } from "../config/env.mjs";

const downloadSelectorPairs = [
  {
    xmlSelector: 'a:has-text("Descargar XML"), button:has-text("Descargar XML")',
    pdfSelector: 'a:has-text("Descargar PDF"), button:has-text("Descargar PDF")',
  },
  {
    xmlSelector: 'a:has-text("XML"), button:has-text("XML"), [download$=".xml"], [href$=".xml"]',
    pdfSelector: 'a:has-text("PDF"), button:has-text("PDF"), [download$=".pdf"], [href$=".pdf"]',
  },
  {
    xmlSelector: 'a[href*="xml"], a[download*="xml"], button:has-text("XML")',
    pdfSelector: 'a[href*="pdf"], a[download*="pdf"], button:has-text("PDF")',
  },
];

export async function tryAutoDownloadB2Cfdi(page, { job, timeoutMs = 30000 } = {}) {
  for (const pair of downloadSelectorPairs) {
    const xmlLocator = page.locator(pair.xmlSelector).first();
    const pdfLocator = page.locator(pair.pdfSelector).first();
    const xmlVisible = await xmlLocator.isVisible({ timeout: 800 }).catch(() => false);
    const pdfVisible = await pdfLocator.isVisible({ timeout: 800 }).catch(() => false);

    if (!xmlVisible || !pdfVisible) {
      continue;
    }

    const xml = await captureDownloadFile(page, {
      locator: xmlLocator,
      kind: "xml",
      job,
      timeoutMs,
    });
    const pdf = await captureDownloadFile(page, {
      locator: pdfLocator,
      kind: "pdf",
      job,
      timeoutMs,
    });

    return {
      xmlPath: xml.path,
      pdfPath: pdf.path,
      xmlDownloadFileName: xml.fileName,
      pdfDownloadFileName: pdf.fileName,
      xmlUrl: xml.url,
      pdfUrl: pdf.url,
      xmlSelector: pair.xmlSelector,
      pdfSelector: pair.pdfSelector,
    };
  }

  return null;
}

async function captureDownloadFile(page, { locator, kind, job, timeoutMs }) {
  const outputDir = resolve(getPortalArtifactsDir());
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  await mkdir(outputDir, { recursive: true });

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: timeoutMs }),
    locator.click({ timeout: timeoutMs }),
  ]);
  const suggested = sanitizeFileName(download.suggestedFilename?.() ?? `cfdi.${kind}`, kind);
  const fileName = `b2-${safeFilePart(job?.id ?? "job")}-${stamp}-${kind}-${suggested}`;
  const outputPath = resolve(outputDir, fileName);

  await download.saveAs(outputPath);

  return {
    path: outputPath.replaceAll("\\", "/"),
    fileName,
    url: typeof download.url === "function" ? download.url() : null,
  };
}

function sanitizeFileName(fileName, kind) {
  const fallback = `cfdi.${kind}`;
  const cleaned = String(fileName || fallback)
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "_")
    .slice(0, 120);

  return cleaned.includes(".") ? cleaned : `${cleaned}.${kind}`;
}

function safeFilePart(value) {
  return String(value ?? "unknown")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
