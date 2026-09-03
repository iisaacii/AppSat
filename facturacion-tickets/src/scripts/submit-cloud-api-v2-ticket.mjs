import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { getFirebaseAuth } from "../config/firebase.mjs";

const expectedProjectId = optionalEnv("BILLING_LIVE_EXPECTED_PROJECT_ID", "appsat-dev");
const expectedApiHostPrefix = optionalEnv("BILLING_LIVE_API_HOST_PREFIX", "appsat-billing-stg-api-").toLowerCase();
const apiBaseUrl = normalizeApiBaseUrl(requiredEnv("BILLING_API_BASE_URL"));
const firebaseWebApiKey = requiredEnv("FIREBASE_WEB_API_KEY");
const projectId = requiredEnv("FIREBASE_PROJECT_ID");
const ticketPath = resolve(requiredArg("--ticket"));
const profilePath = resolve(requiredArg("--profile"));
const uid = requiredArg("--uid");
const timeoutMs = positiveArg("--timeout-ms", 900_000);
const idempotencyKey = optionalArg("--idempotency-key") ?? `v2-live-${randomUUID()}`;

if (!process.argv.includes("--confirm-staging")) {
  throw new Error("Pass --confirm-staging to submit a real staging ticket.");
}
if (!process.argv.includes("--allow-final-submit")) {
  throw new Error("Pass --allow-final-submit because API v2 can issue a real CFDI.");
}
if (projectId !== expectedProjectId) {
  throw new Error(`Live ticket submission is restricted to ${expectedProjectId}.`);
}
if (!/^[a-z0-9-]+$/.test(expectedApiHostPrefix)) {
  throw new Error("BILLING_LIVE_API_HOST_PREFIX must contain only lowercase letters, digits and hyphens.");
}
if (!apiBaseUrl.hostname.toLowerCase().startsWith(expectedApiHostPrefix)) {
  throw new Error(`BILLING_API_BASE_URL must point to the expected staging API (${expectedApiHostPrefix}...).`);
}

const ticketBytes = await readFile(ticketPath);
const profileSource = JSON.parse(await readFile(profilePath, "utf8"));
const taxProfile = projectTaxProfile(profileSource.taxProfile ?? profileSource);
const idToken = await exchangeCustomToken(
  await getFirebaseAuth().createCustomToken(uid),
  firebaseWebApiKey,
);

const form = new FormData();
form.append(
  "ticket",
  new Blob([ticketBytes], { type: mimeFor(ticketPath) }),
  basename(ticketPath),
);
form.append("taxProfile", JSON.stringify(taxProfile));

const created = await apiRequest("/v2/billing/jobs", idToken, {
  method: "POST",
  headers: { "Idempotency-Key": idempotencyKey },
  body: form,
});
const jobId = created.data?.id;
assert(jobId, "Billing API v2 did not return a job id.");
assert(created.meta?.apiVersion === "billing-http.v2", "API did not return the v2 contract.");

console.log(JSON.stringify({
  event: "submitted",
  jobId,
  reused: created.meta?.reused === true,
  status: created.data?.status ?? null,
  workflowStage: created.data?.workflowStage ?? null,
}, null, 2));

const deadline = Date.now() + timeoutMs;
let lastFingerprint = null;
let job = null;
while (Date.now() < deadline) {
  job = (await apiRequest(`/v2/billing/jobs/${jobId}`, idToken)).data;
  const fingerprint = [job?.status, job?.workflowStage, job?.statusMessage].join("|");
  if (fingerprint !== lastFingerprint) {
    console.log(JSON.stringify({
      event: "status",
      jobId,
      status: job?.status ?? null,
      workflowStage: job?.workflowStage ?? null,
      statusMessage: job?.statusMessage ?? null,
      attemptCount: job?.attemptCount ?? 0,
    }, null, 2));
    lastFingerprint = fingerprint;
  }

  if (job?.isTerminal || job?.needsUserAction) break;
  await sleep(Math.max(1_000, Math.min(10_000, Number(job?.pollAfterMs) || 3_000)));
}

if (!job?.isTerminal && !job?.needsUserAction) {
  throw new Error(`API v2 live ticket timed out in status ${job?.status ?? "unknown"}.`);
}

const events = await apiRequest(`/v2/billing/jobs/${jobId}/events?limit=100`, idToken);
console.log(JSON.stringify({
  ok: true,
  jobId,
  idempotencyKey,
  status: job.status,
  workflowStage: job.workflowStage,
  statusMessage: job.statusMessage,
  ticket: job.ticket,
  ocrResolution: job.ocrResolution,
  result: job.result,
  error: job.error,
  userAction: job.userAction,
  eventTypes: (events.data ?? []).map((event) => event.type),
  preserved: true,
}, null, 2));

async function apiRequest(path, token, init = {}) {
  const response = await fetch(new URL(path, `${apiBaseUrl.href}/`), {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Billing API ${init.method ?? "GET"} ${path} failed (${response.status}): ` +
        `${body.error?.code ?? "unknown"} ${body.error?.message ?? ""}`.trim(),
    );
  }
  return body;
}

async function exchangeCustomToken(customToken, apiKey) {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    },
  );
  const body = await response.json();
  if (!response.ok || !body.idToken) {
    throw new Error(`Firebase custom-token exchange failed (${response.status}).`);
  }
  return body.idToken;
}

function projectTaxProfile(source) {
  const fields = [
    "rfc",
    "legalName",
    "email",
    "fiscalRegime",
    "fiscalRegimes",
    "cfdiUse",
    "postalCode",
    "street",
    "exteriorNumber",
    "interiorNumber",
    "neighborhood",
    "municipality",
    "state",
    "country",
  ];
  return Object.fromEntries(fields.map((field) => [field, source[field] ?? ""]));
}

function mimeFor(path) {
  const extension = extname(path).toLowerCase();
  const mime = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".avif": "image/avif",
  }[extension];
  if (!mime) throw new Error(`Unsupported ticket extension: ${extension || "none"}.`);
  return mime;
}

function normalizeApiBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("BILLING_API_BASE_URL must use HTTPS.");
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

function requiredArg(name) {
  const value = optionalArg(name);
  if (!value) throw new Error(`Missing ${name}=... argument.`);
  return value;
}

function optionalArg(name) {
  return process.argv.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1) || null;
}

function positiveArg(name, fallback) {
  const raw = optionalArg(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function requiredEnv(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`Missing environment variable ${name}.`);
  return value;
}

function optionalEnv(name, fallback) {
  return String(process.env[name] ?? fallback).trim() || fallback;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
