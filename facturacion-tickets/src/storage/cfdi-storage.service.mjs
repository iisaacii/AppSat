import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getCfdiStorageMode, getCfdiStoragePrefix, shouldUsePortalFixture } from "../config/env.mjs";
import { getFirebaseStorageBucket } from "../config/firebase.mjs";
import { CfdiValidationError, validateCfdiXmlText } from "../cfdi/cfdi-validator.mjs";
import { downloadExternalResource } from "../security/external-url-policy.mjs";
import { logger } from "../shared/logger.mjs";

export class CfdiArtifactMissingError extends Error {
  constructor(kind, sourceUrl = null) {
    super(`La ejecucion del portal no produjo un archivo CFDI ${String(kind).toUpperCase()} real.`);
    this.name = "CfdiArtifactMissingError";
    this.code = "cfdi_artifact_missing";
    this.kind = kind;
    this.sourceUrl = sourceUrl;
  }
}

export async function materializeCfdiResult({ job, template, templateResult, extracted }) {
  const mode = getCfdiStorageMode();

  if (mode !== "firebase") {
    const cfdiValidationResult = await validateTemplateResultXml({
      templateResult,
      expected: buildExpectedCfdi({ job, template, extracted }),
      allowMissing: mode === "mock",
      allowDevelopmentPlaceholder: mode === "mock" || shouldUsePortalFixture(),
    });
    return {
      resultXmlUrl: templateResult.xmlUrl,
      resultPdfUrl: templateResult.pdfUrl,
      resultXmlPath: templateResult.xmlPath ?? null,
      resultPdfPath: templateResult.pdfPath ?? null,
      cfdiStorageMode: mode,
      cfdiSource: buildCfdiSource(templateResult),
      cfdiValidationResult,
    };
  }

  const allowDevelopmentPlaceholder = shouldUsePortalFixture();
  if (!allowDevelopmentPlaceholder && !hasMaterializableCfdiAsset(templateResult, "xml")) {
    throw new CfdiArtifactMissingError("xml", templateResult.xmlUrl ?? null);
  }
  const bucket = getFirebaseStorageBucket();
  const basePath = buildBasePath(job);
  const xml = await resolveCfdiAsset("xml", templateResult, job, template, extracted, {
    allowDevelopmentPlaceholder,
  });
  const cfdiValidationResult = validateAndAssertXml({
    asset: xml,
    expected: buildExpectedCfdi({ job, template, extracted }),
    allowDevelopmentPlaceholder,
  });
  const pdf = allowDevelopmentPlaceholder
    ? await resolveCfdiAsset("pdf", templateResult, job, template, extracted, {
        allowDevelopmentPlaceholder: true,
      })
    : await resolveAvailableCfdiAsset("pdf", templateResult);

  const xmlUpload = await uploadCfdiAsset(bucket, {
    path: `${basePath}/cfdi.xml`,
    content: xml.content,
    contentType: xml.contentType,
    sourceUrl: xml.sourceUrl,
  });
  const pdfUpload = pdf
    ? await uploadCfdiAsset(bucket, {
        path: `${basePath}/cfdi.pdf`,
        content: pdf.content,
        contentType: pdf.contentType,
        sourceUrl: pdf.sourceUrl,
      })
    : null;

  logger.info("CFDI files stored.", {
    jobId: job.id,
    bucket: bucket.name,
    xmlPath: xmlUpload.path,
    pdfPath: pdfUpload?.path ?? null,
  });

  return {
    resultXmlUrl: xmlUpload.downloadUrl,
    resultPdfUrl: pdfUpload?.downloadUrl ?? null,
    resultXmlStoragePath: xmlUpload.path,
    resultPdfStoragePath: pdfUpload?.path ?? null,
    cfdiStorageBucket: bucket.name,
    cfdiStorageMode: mode,
    cfdiStoredAt: new Date().toISOString(),
    cfdiSource: buildCfdiSource(templateResult),
    cfdiValidationResult,
    cfdiArtifactWarnings: pdf ? [] : ["pdf_not_available"],
  };
}

export function hasMaterializableCfdiAsset(templateResult = {}, kind) {
  const content = templateResult[`${kind}Content`];
  const path = templateResult[`${kind}Path`];
  const url = templateResult[`${kind}Url`];
  return Boolean(
    (content !== null && content !== undefined && content !== "") ||
    (typeof path === "string" && path.trim()) ||
    (typeof url === "string" && /^(?:https?):\/\//i.test(url.trim())),
  );
}

export async function materializeAvailableCfdiResult({ job, templateResult, template = null, extracted = {} }) {
  const mode = getCfdiStorageMode();

  if (mode !== "firebase") {
    const cfdiValidationResult = await validateTemplateResultXml({
      templateResult,
      expected: buildExpectedCfdi({ job, template, extracted }),
      allowMissing: true,
      allowDevelopmentPlaceholder: mode === "mock" || shouldUsePortalFixture(),
    });
    return {
      resultXmlUrl: templateResult.xmlUrl ?? null,
      resultPdfUrl: templateResult.pdfUrl ?? null,
      resultXmlPath: templateResult.xmlPath ?? null,
      resultPdfPath: templateResult.pdfPath ?? null,
      cfdiStorageMode: mode,
      cfdiSource: buildCfdiSource(templateResult),
      cfdiValidationResult,
    };
  }

  const bucket = getFirebaseStorageBucket();
  const basePath = buildBasePath(job);
  const xml = await resolveAvailableCfdiAsset("xml", templateResult);
  const pdf = await resolveAvailableCfdiAsset("pdf", templateResult);
  const cfdiValidationResult = xml
    ? validateAndAssertXml({
        asset: xml,
        expected: buildExpectedCfdi({ job, template, extracted }),
        allowDevelopmentPlaceholder: shouldUsePortalFixture(),
      })
    : {
        ok: false,
        errors: ["Fiscal XML is not available"],
        warnings: [],
        validatedAt: new Date().toISOString(),
      };
  const result = {
    resultXmlUrl: null,
    resultPdfUrl: null,
    resultXmlStoragePath: null,
    resultPdfStoragePath: null,
    cfdiStorageBucket: bucket.name,
    cfdiStorageMode: mode,
    cfdiStoredAt: new Date().toISOString(),
    cfdiSource: buildCfdiSource(templateResult),
    cfdiValidationResult,
  };

  if (xml) {
    const xmlUpload = await uploadCfdiAsset(bucket, {
      path: `${basePath}/cfdi.xml`,
      content: xml.content,
      contentType: xml.contentType,
      sourceUrl: xml.sourceUrl,
    });
    result.resultXmlUrl = xmlUpload.downloadUrl;
    result.resultXmlStoragePath = xmlUpload.path;
  }

  if (pdf) {
    const pdfUpload = await uploadCfdiAsset(bucket, {
      path: `${basePath}/cfdi.pdf`,
      content: pdf.content,
      contentType: pdf.contentType,
      sourceUrl: pdf.sourceUrl,
    });
    result.resultPdfUrl = pdfUpload.downloadUrl;
    result.resultPdfStoragePath = pdfUpload.path;
  }

  logger.info("Available CFDI files stored.", {
    jobId: job.id,
    bucket: bucket.name,
    xmlPath: result.resultXmlStoragePath,
    pdfPath: result.resultPdfStoragePath,
  });

  return result;
}

function buildBasePath(job) {
  const uid = sanitizePathSegment(job.uid ?? "unknown_user");
  const jobId = sanitizePathSegment(job.id);
  return `${getCfdiStoragePrefix()}/${uid}/${jobId}`;
}

async function validateTemplateResultXml({
  templateResult,
  expected,
  allowMissing,
  allowDevelopmentPlaceholder,
}) {
  const asset = await resolveAvailableCfdiAsset("xml", templateResult);

  if (!asset) {
    if (allowMissing) {
      return {
        ok: true,
        skipped: true,
        reason: "xml_not_materialized_in_current_storage_mode",
        errors: [],
        warnings: [],
        validatedAt: new Date().toISOString(),
      };
    }
    throw new CfdiValidationError({
      ok: false,
      errors: ["Fiscal XML is not available"],
      warnings: [],
      validatedAt: new Date().toISOString(),
    });
  }

  return validateAndAssertXml({ asset, expected, allowDevelopmentPlaceholder });
}

function validateAndAssertXml({ asset, expected, allowDevelopmentPlaceholder }) {
  const result = validateCfdiXmlText({
    xml: asset.content,
    expected,
    sourcePath: asset.sourceUrl ?? null,
    allowDevelopmentPlaceholder,
  });

  if (!result.ok) {
    throw new CfdiValidationError(result);
  }

  return result;
}

function buildExpectedCfdi({ job = {}, template = null, extracted = {} }) {
  return {
    rfcEmisor: extracted.rfcEmisor ?? job.rfcEmisor ?? template?.rfcEmisor ?? null,
    rfcReceptor: job.taxProfile?.rfc ?? job.rfcReceptor ?? extracted.rfcReceptor ?? null,
    monto: extracted.monto ?? job.monto ?? null,
    fecha: extracted.fecha ?? job.fecha ?? null,
  };
}

async function resolveCfdiAsset(
  kind,
  templateResult,
  job,
  template,
  extracted,
  { allowDevelopmentPlaceholder = false } = {},
) {
  const contentKey = `${kind}Content`;
  const pathKey = `${kind}Path`;
  const urlKey = `${kind}Url`;
  const contentType = kind === "xml" ? "application/xml" : "application/pdf";
  const sourceUrl = templateResult[urlKey] ?? null;

  if (templateResult[contentKey]) {
    return {
      content: Buffer.from(String(templateResult[contentKey]), "utf8"),
      contentType,
      sourceUrl,
    };
  }

  if (templateResult[pathKey]) {
    return {
      content: await readFile(templateResult[pathKey]),
      contentType,
      sourceUrl,
    };
  }

  if (sourceUrl?.startsWith("http://") || sourceUrl?.startsWith("https://")) {
    return downloadCfdiAsset(sourceUrl, contentType);
  }

  if (allowDevelopmentPlaceholder) {
    return {
      content:
        kind === "xml"
          ? buildDevelopmentXml(job, template, extracted, sourceUrl)
          : buildDevelopmentPdf(job, template, extracted, sourceUrl),
      contentType,
      sourceUrl,
    };
  }

  throw new CfdiArtifactMissingError(kind, sourceUrl);
}

async function resolveAvailableCfdiAsset(kind, templateResult) {
  const contentKey = `${kind}Content`;
  const pathKey = `${kind}Path`;
  const urlKey = `${kind}Url`;
  const contentType = kind === "xml" ? "application/xml" : "application/pdf";
  const sourceUrl = templateResult[urlKey] ?? null;

  if (templateResult[contentKey]) {
    return {
      content: Buffer.from(String(templateResult[contentKey]), "utf8"),
      contentType,
      sourceUrl,
    };
  }

  if (templateResult[pathKey]) {
    return {
      content: await readFile(templateResult[pathKey]),
      contentType,
      sourceUrl,
    };
  }

  if (sourceUrl?.startsWith("http://") || sourceUrl?.startsWith("https://")) {
    return downloadCfdiAsset(sourceUrl, contentType);
  }

  return null;
}

async function downloadCfdiAsset(url, fallbackContentType) {
  const resource = await downloadExternalResource(url, {
    maxBytes: 10 * 1024 * 1024,
    timeoutMs: 30000,
  });
  const contentType = resource.contentType.split(";", 1)[0].trim().toLowerCase();
  const isPdf = fallbackContentType === "application/pdf";

  if (isPdf && !resource.buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new Error("La descarga marcada como PDF no contiene un PDF valido.");
  }

  return {
    content: resource.buffer,
    contentType: contentType || fallbackContentType,
    sourceUrl: resource.finalUrl,
  };
}

async function uploadCfdiAsset(bucket, asset) {
  const token = randomUUID();
  const file = bucket.file(asset.path);

  await file.save(asset.content, {
    resumable: false,
    metadata: {
      contentType: asset.contentType,
      metadata: {
        firebaseStorageDownloadTokens: token,
        easysatSourceUrl: asset.sourceUrl ?? "generated-dev-placeholder",
      },
    },
  });

  return {
    path: asset.path,
    downloadUrl: buildFirebaseDownloadUrl(bucket.name, asset.path, token),
  };
}

function buildCfdiSource(templateResult) {
  return {
    xmlUrl: templateResult.xmlUrl ?? null,
    pdfUrl: templateResult.pdfUrl ?? null,
    xmlPath: templateResult.xmlPath ?? null,
    pdfPath: templateResult.pdfPath ?? null,
    downloadMode: templateResult.downloadMode ?? null,
    xmlDownloadFileName: templateResult.xmlDownloadFileName ?? null,
    pdfDownloadFileName: templateResult.pdfDownloadFileName ?? null,
  };
}

function buildFirebaseDownloadUrl(bucketName, path, token) {
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(
    path,
  )}?alt=media&token=${token}`;
}

function buildDevelopmentXml(job, template, extracted, sourceUrl) {
  return Buffer.from(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<easysatCfdiPlaceholder>',
      `  <job id="${escapeXml(job.id)}" uid="${escapeXml(job.uid ?? "")}" />`,
      `  <template id="${escapeXml(template?.id ?? "")}" rfcEmisor="${escapeXml(template?.rfcEmisor ?? "")}" />`,
      `  <ticket rfcReceptor="${escapeXml(job.rfcReceptor ?? "")}" folio="${escapeXml(
        extracted.folio ?? "",
      )}" fecha="${escapeXml(extracted.fecha ?? "")}" monto="${escapeXml(extracted.monto ?? "")}" />`,
      `  <source>${escapeXml(sourceUrl ?? "generated-dev-placeholder")}</source>`,
      "</easysatCfdiPlaceholder>",
      "",
    ].join("\n"),
    "utf8",
  );
}

function buildDevelopmentPdf(job, template, extracted, sourceUrl) {
  const lines = [
    "EasySat CFDI placeholder",
    `Job: ${job.id}`,
    `Template: ${template?.id ?? "-"}`,
    `RFC emisor: ${template?.rfcEmisor ?? "-"}`,
    `Folio: ${extracted.folio ?? "-"}`,
    `Fecha: ${extracted.fecha ?? "-"}`,
    `Monto: ${extracted.monto ?? "-"}`,
    `Source: ${sourceUrl ?? "generated-dev-placeholder"}`,
  ];

  return Buffer.from(buildSimplePdf(lines), "binary");
}

function buildSimplePdf(lines) {
  const text = lines.map((line, index) => `BT /F1 12 Tf 72 ${740 - index * 18} Td (${escapePdfText(line)}) Tj ET`).join("\n");
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj",
    "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    `5 0 obj << /Length ${Buffer.byteLength(text, "binary")} >> stream\n${text}\nendstream endobj`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];

  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, "binary"));
    pdf += `${object}\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, "binary");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;
  return pdf;
}

function sanitizePathSegment(value) {
  return String(value ?? "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapePdfText(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
