import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import jpeg from "jpeg-js";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import {
  getPortalDiscoveryProbeTimeoutMs,
  getFirebaseStorageBucketName,
  isPortalDiscoveryProbeEnabled,
  isPortalDiscoveryQrEnabled,
} from "../config/env.mjs";
import {
  assertSafeExternalUrl,
  assertTrustedTicketFileUrl,
  downloadExternalResource,
  installSafePageNetworkGuard,
  validateExternalUrlStructure,
} from "../security/external-url-policy.mjs";

const facturaTextPattern = /factur|cfdi|comprobante|ticket|token|serie|link|qr/i;
const facturaLinkPattern = /factur|cfdi|comprobante|invoice|billing/i;
const allowedPortalTlds = new Set([
  "app",
  "com",
  "com.mx",
  "dev",
  "edu.mx",
  "gob.mx",
  "io",
  "mx",
  "net",
  "net.mx",
  "org",
  "org.mx",
  "store",
]);

export async function discoverPortalFromTicket({
  job,
  extracted,
  decodeQr = isPortalDiscoveryQrEnabled(),
  probeUrls = isPortalDiscoveryProbeEnabled(),
} = {}) {
  const rawText = extracted?.ocrText ?? extracted?.ocrTextPreview ?? "";
  const fields = extractPortalTicketFields(rawText);
  const textUrlCandidates = extractPortalUrlCandidatesFromText(rawText);
  const providedQrValues = uniqueStrings([
    ...toArray(extracted?.qrValues),
    ...toArray(extracted?.ocrCandidates?.qrValues),
  ]);
  const decodedQrResult =
    decodeQr && shouldAttemptQrDecode(rawText)
      ? await decodeQrValuesFromTicket(job?.ticketFileUrl, job?.uid).catch((error) => ({
          values: [],
          error: error.message,
        }))
      : { values: [] };
  const qrResult = {
    values: uniqueStrings([...providedQrValues, ...(decodedQrResult.values ?? [])]),
    error: decodedQrResult.error ?? null,
  };
  const qrUrlCandidates = qrResult.values.flatMap((value) => extractPortalUrlCandidatesFromText(value, "qr"));
  const baseCandidates = uniqueCandidates([...qrUrlCandidates, ...textUrlCandidates]);
  const probeResults = probeUrls && baseCandidates.length
    ? await probePortalUrlCandidates(baseCandidates)
    : [];
  const probeCandidates = probeResults.flatMap((result) => result.portalCandidates ?? []);
  const portalCandidates = uniqueCandidates([...qrUrlCandidates, ...probeCandidates, ...textUrlCandidates]);
  const bestCandidate = portalCandidates[0] ?? null;

  return {
    status: portalCandidates.length || Object.keys(fields).length || qrResult.values.length ? "completed" : "not_found",
    fields,
    qrValues: qrResult.values,
    qrDecodeError: qrResult.error ?? null,
    urlCandidates: textUrlCandidates,
    portalCandidates,
    bestCandidate,
    probeResults,
  };
}

export function applyPortalDiscoveryToExtraction(extracted, portalDiscovery) {
  if (!portalDiscovery) {
    return extracted;
  }

  const fields = portalDiscovery.fields ?? {};
  const bestCandidate = portalDiscovery.bestCandidate ?? null;
  const ocrCandidates = {
    ...(extracted.ocrCandidates ?? {}),
    ...fields,
    portalUrls: portalDiscovery.portalCandidates?.map((candidate) => candidate.url) ?? [],
    qrValues: portalDiscovery.qrValues ?? [],
  };
  const nextFolio = extracted.folio ?? fields.folioTicket ?? fields.noTicket ?? fields.noVenta ?? null;
  const nextTicketId = extracted.ocrCandidates?.ticketId ?? fields.folioTicket ?? fields.noTicket ?? fields.noVenta ?? null;

  return {
    ...extracted,
    folio: nextFolio,
    portalUrl: extracted.portalUrl ?? bestCandidate?.url ?? null,
    portalDiscovery,
    ocrCandidates: {
      ...ocrCandidates,
      ticketId: nextTicketId,
    },
  };
}

export function extractPortalTicketFields(rawText) {
  const text = normalizeForPatterns(rawText);
  const fields = {
    sucursal: firstMatch(text, /(?:\bSUCURSAL\b|SUC\.)\s*[:#-]?\s*([A-Z0-9-]{2,16})/),
    ticketHash: firstMatch(text, /\bTICKET\s*#\s*([A-Z0-9-]{3,24})/),
    folioTicket: firstMatch(text, /(?:FOLIO\s*TICKET|FOLIO\s*DE\s*TICKET)\s*[:#-]?\s*([A-Z0-9-]{3,24})/),
    noTicket: firstMatch(text, /(?:NO\.?\s*TICKET|NUM(?:ERO)?\.?\s*TICKET)\s*[:#-]?\s*([A-Z0-9-]{3,24})/),
    noVenta: firstMatch(text, /(?:NO\.?\s*VENTA|NUM(?:ERO)?\.?\s*VENTA)\s*[:#-]?\s*([A-Z0-9-]{3,24})/),
    serie: firstMatch(text, /\bSERIE\s*[:#-]?\s*([A-Z0-9-]{2,24})/),
    token: firstMatch(text, /\bTOKEN\s*[:#-]?\s*([A-Z0-9-]{4,40})/),
  };

  const normalizedFields = {
    ...fields,
    folioTicket: fields.folioTicket ?? fields.ticketHash,
    noTicket: fields.noTicket ?? fields.ticketHash,
  };

  return Object.fromEntries(Object.entries(normalizedFields).filter(([, value]) => Boolean(value)));
}

export function extractPortalUrlCandidatesFromText(rawText, source = "ocr_text") {
  const text = String(rawText ?? "");
  const matches = [...text.matchAll(/\b(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+(?:\/[^\s"'<>]*)?/gi)];
  const candidates = [];

  for (const match of matches) {
    const normalizedUrl = normalizePortalUrl(match[0]);

    if (!normalizedUrl) {
      continue;
    }

    candidates.push({
      url: normalizedUrl,
      source,
      confidence: source === "qr" ? 0.96 : scoreUrlCandidate(match[0], text),
    });
  }

  return uniqueCandidates(candidates);
}

async function decodeQrValuesFromTicket(ticketFileUrl, uid) {
  if (!ticketFileUrl || ticketFileUrl.startsWith("mock://")) {
    return { values: [] };
  }

  const image = await loadTicketImage(ticketFileUrl, uid);
  const decoded = decodeImage(image);

  if (!decoded) {
    return { values: [] };
  }

  const values = [];
  const regions = buildQrScanRegions(decoded.width, decoded.height);

  for (const region of regions) {
    const crop = cropRgba(decoded, region);
    const qr = jsQR(new Uint8ClampedArray(crop.data), crop.width, crop.height, {
      inversionAttempts: "attemptBoth",
    });

    if (qr?.data && !values.includes(qr.data)) {
      values.push(qr.data);
    }
  }

  return { values };
}

async function loadTicketImage(ticketFileUrl, uid) {
  if (/^https?:\/\//i.test(ticketFileUrl)) {
    assertTrustedTicketFileUrl(ticketFileUrl, {
      uid,
      bucketName: getFirebaseStorageBucketName(),
    });
    const resource = await downloadExternalResource(ticketFileUrl, {
      protocols: ["https:"],
      maxBytes: 10 * 1024 * 1024,
      timeoutMs: 30000,
    });
    const mimeType = resource.contentType.split(";", 1)[0].trim().toLowerCase();

    if (!mimeType.startsWith("image/")) {
      throw new Error(`El archivo para QR no es una imagen valida (${mimeType || "sin content-type"}).`);
    }

    return {
      bytes: resource.buffer,
      mimeType,
      path: resource.finalUrl,
    };
  }

  const filePath = ticketFileUrl.startsWith("file://")
    ? fileURLToPath(ticketFileUrl)
    : isAbsolute(ticketFileUrl)
      ? ticketFileUrl
      : resolve(ticketFileUrl);
  validateExternalUrlStructure(pathToFileURL(filePath).href, {
    allowFile: true,
    allowedFileRoots: [process.cwd()],
  });

  return {
    bytes: await readFile(filePath),
    mimeType: guessMimeType(filePath),
    path: filePath,
  };
}

function decodeImage({ bytes, mimeType, path }) {
  const extension = extname(path ?? "").toLowerCase();

  if (mimeType === "image/png" || extension === ".png") {
    const png = PNG.sync.read(bytes);
    return {
      width: png.width,
      height: png.height,
      data: png.data,
    };
  }

  if (["image/jpeg", "image/jpg"].includes(mimeType) || [".jpg", ".jpeg"].includes(extension)) {
    const image = jpeg.decode(bytes, { useTArray: true });
    return {
      width: image.width,
      height: image.height,
      data: image.data,
    };
  }

  return null;
}

async function probePortalUrlCandidates(candidates) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== "false",
  });
  const results = [];

  try {
    for (const candidate of candidates.slice(0, 3)) {
      const result = await probePortalUrl(browser, candidate).catch((error) => ({
        sourceUrl: candidate.url,
        status: "failed",
        error: error.message,
        portalCandidates: [],
      }));
      results.push(result);
    }
  } finally {
    await browser.close();
  }

  return results;
}

async function probePortalUrl(browser, candidate) {
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await installSafePageNetworkGuard(page);
  const attempts = buildNavigationAttempts(candidate.url);

  try {
    let lastError = null;

    for (const url of attempts) {
      try {
        const safeUrl = await assertSafeExternalUrl(url);
        await page.goto(safeUrl.href, {
          waitUntil: "domcontentloaded",
          timeout: getPortalDiscoveryProbeTimeoutMs(),
        });
        await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (page.url() === "about:blank") {
      throw lastError ?? new Error("No se pudo abrir URL candidata");
    }

    const pageState = await page.evaluate(() => {
      const normalize = (value) =>
        String(value ?? "")
          .replace(/\s+/g, " ")
          .trim();
      const links = [...document.querySelectorAll("a[href], button")]
        .map((element) => {
          const href = element.getAttribute("href");
          const text = normalize(element.innerText || element.textContent || element.getAttribute("aria-label"));
          let url = null;

          try {
            url = href ? new URL(href, location.href).href : null;
          } catch {
            url = null;
          }

          return {
            text,
            url,
          };
        })
        .filter((entry) => entry.text || entry.url);

      return {
        title: document.title || null,
        currentUrl: location.href,
        visibleTextPreview: normalize(document.body?.innerText).slice(0, 1600),
        links,
      };
    });
    const facturaLinks = pageState.links.filter((link) => facturaLinkPattern.test(`${link.text} ${link.url ?? ""}`));
    const portalCandidates = uniqueCandidates([
      ...facturaLinks
        .filter((link) => link.url)
        .map((link) => ({
          url: normalizePortalUrl(link.url),
          source: candidate.source === "qr" ? "qr_portal_probe_facturacion_link" : "portal_probe_facturacion_link",
          originSource: candidate.source ?? null,
          sourceUrl: candidate.url,
          confidence: 0.98,
          name: link.text || null,
        })),
      ...(facturaLinkPattern.test(pageState.visibleTextPreview)
        ? [
            {
              url: pageState.currentUrl,
              source: candidate.source === "qr" ? "qr_portal_probe_current_page" : "portal_probe_current_page",
              originSource: candidate.source ?? null,
              sourceUrl: candidate.url,
              confidence: 0.84,
              name: pageState.title,
            },
          ]
        : []),
    ]);

    return {
      sourceUrl: candidate.url,
      status: "completed",
      finalUrl: pageState.currentUrl,
      title: pageState.title,
      visibleTextPreview: pageState.visibleTextPreview,
      portalCandidates,
    };
  } finally {
    await page.close();
  }
}

function buildQrScanRegions(width, height) {
  return [
    { name: "full", x: 0, y: 0, width, height },
    { name: "bottom", x: 0, y: Math.floor(height * 0.45), width, height: Math.ceil(height * 0.55) },
    {
      name: "bottom_right",
      x: Math.floor(width * 0.35),
      y: Math.floor(height * 0.45),
      width: Math.ceil(width * 0.65),
      height: Math.ceil(height * 0.55),
    },
    {
      name: "lower_middle",
      x: Math.floor(width * 0.15),
      y: Math.floor(height * 0.55),
      width: Math.ceil(width * 0.7),
      height: Math.ceil(height * 0.35),
    },
  ];
}

function cropRgba(image, region) {
  const data = Buffer.alloc(region.width * region.height * 4);

  for (let y = 0; y < region.height; y += 1) {
    const sourceStart = ((region.y + y) * image.width + region.x) * 4;
    const targetStart = y * region.width * 4;
    data.set(image.data.subarray(sourceStart, sourceStart + region.width * 4), targetStart);
  }

  return {
    width: region.width,
    height: region.height,
    data,
  };
}

function buildNavigationAttempts(url) {
  const attempts = [url];

  if (url.startsWith("https://")) {
    attempts.push(url.replace(/^https:\/\//, "http://"));
  }

  return attempts;
}

function normalizePortalUrl(value) {
  const trimmed = String(value ?? "")
    .trim()
    .replace(/[),.;]+$/g, "");

  if (!trimmed || trimmed.includes("@")) {
    return null;
  }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const parsed = new URL(withScheme);
    const host = parsed.hostname.toLowerCase();
    const labels = host.split(".");
    const tld = labels.at(-1) ?? "";
    const compoundTld = labels.length >= 2 ? `${labels.at(-2)}.${labels.at(-1)}` : tld;

    if (labels.length < 2 || tld.length < 2 || !/[a-z]/.test(host)) {
      return null;
    }

    if (!allowedPortalTlds.has(tld) && !allowedPortalTlds.has(compoundTld)) {
      return null;
    }

    parsed.hash = "";
    return parsed.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  const unique = [];

  for (const candidate of candidates) {
    const url = normalizePortalUrl(candidate?.url);

    if (!url || seen.has(url)) {
      continue;
    }

    seen.add(url);
    unique.push({
      ...candidate,
      url,
      confidence: Number.isFinite(candidate.confidence) ? candidate.confidence : 0.75,
    });
  }

  return unique.sort((a, b) => {
    const priority = getCandidateSourcePriority(b) - getCandidateSourcePriority(a);

    if (priority !== 0) {
      return priority;
    }

    return b.confidence - a.confidence;
  });
}

function scoreUrlCandidate(value, fullText) {
  const before = fullText.slice(Math.max(0, fullText.indexOf(value) - 80), fullText.indexOf(value));
  const contextScore = facturaTextPattern.test(before) ? 0.9 : 0.78;
  return /^https?:\/\//i.test(value) ? Math.max(contextScore, 0.86) : contextScore;
}

function getCandidateSourcePriority(candidate) {
  const source = String(candidate?.source ?? "");
  const originSource = String(candidate?.originSource ?? "");

  if (source === "qr" || source.startsWith("qr_") || originSource === "qr") {
    return 4;
  }

  if (source.startsWith("portal_probe")) {
    return 3;
  }

  if (source === "ocr_text") {
    return 2;
  }

  return 1;
}

function firstMatch(text, pattern) {
  return text.match(pattern)?.[1]?.replace(/[^A-Z0-9-]/g, "").trim() || null;
}

function normalizeForPatterns(value) {
  return String(value ?? "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[ \t]+/g, " ");
}

function shouldAttemptQrDecode(rawText) {
  const text = String(rawText ?? "");
  return !text.trim() || facturaTextPattern.test(text);
}

function guessMimeType(value) {
  const extension = extname(String(value ?? "").split("?")[0]).toLowerCase();

  if ([".jpg", ".jpeg"].includes(extension)) return "image/jpeg";
  if (extension === ".png") return "image/png";

  return "application/octet-stream";
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}
