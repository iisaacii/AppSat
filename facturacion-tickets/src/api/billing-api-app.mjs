import { randomUUID } from "node:crypto";
import { BillingApiError, forbidden, notFound, unauthorized } from "./api-error.mjs";
import { projectPublicBillingEvent, projectPublicBillingJob } from "./public-job-view.mjs";
import { readAutonomousBillingRequest } from "./billing-v2-request.mjs";

const apiVersionV1 = "billing-http.v1";
const apiVersionV2 = "billing-http.v2";

export function createBillingApiHandler({
  repository,
  verifyIdToken,
  verifyServiceToken = null,
  allowedOrigins = [],
  bodyLimitBytes = 65_536,
  ticketLimitBytes = 10 * 1024 * 1024,
  ticketUpload = null,
  rateLimiter = createMemoryRateLimiter(),
  dispatchJobSignal = null,
  dispatchCommandSignal = null,
  logger = null,
} = {}) {
  if (!repository) throw new Error("Billing API repository is required");
  if (typeof verifyIdToken !== "function") throw new Error("verifyIdToken is required");

  const allowedOriginSet = new Set(allowedOrigins);

  return async function billingApiHandler(request, response) {
    const requestId = clean(request.headers["x-request-id"]) || randomUUID();
    const startedAt = Date.now();
    response.setHeader("X-Request-Id", requestId);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");

    try {
      applyCors(request, response, allowedOriginSet);
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }

      const url = new URL(request.url ?? "/", "http://billing-api.local");
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        (url.pathname === "/health" || url.pathname === "/healthz")
      ) {
        sendJson(response, 200, {
          status: "ok",
          version: apiVersionV1,
          latestVersion: apiVersionV2,
          supportedVersions: [apiVersionV1, apiVersionV2],
        }, request.method === "HEAD");
        return;
      }

      const identity = await authenticateRequest(request, verifyIdToken, verifyServiceToken);
      const rate = rateLimiter.consume(identity.uid);
      if (!rate.allowed) {
        response.setHeader("Retry-After", String(rate.retryAfterSeconds));
        throw new BillingApiError(429, "rate_limit_exceeded", "Demasiadas solicitudes");
      }
      response.setHeader("X-RateLimit-Limit", String(rate.limit));
      response.setHeader("X-RateLimit-Remaining", String(rate.remaining));

      const route = matchRoute(request.method, url.pathname);
      if (!route) throw notFound("Endpoint no encontrado");

      if (route.name === "create_job") {
        const body = await readJsonBody(request, bodyLimitBytes);
        const result = await repository.createJob({
          uid: identity.uid,
          body,
          idempotencyKey: request.headers["idempotency-key"] ?? null,
        });
        await notifyDispatch(dispatchJobSignal, {
          uid: identity.uid,
          jobId: result.job.id,
          lane: "ocr",
          generation: "created",
          reason: result.reused ? "api_job_reused" : "api_job_created",
        }, logger);
        response.setHeader("Location", `/v1/billing/jobs/${result.job.id}`);
        sendJson(response, 202, {
          data: projectPublicBillingJob(result.job),
          meta: { requestId, reused: result.reused, apiVersion: apiVersionV1 },
        });
        return;
      }

      if (route.name === "create_autonomous_job") {
        if (!ticketUpload?.save || typeof repository.createAutonomousJob !== "function") {
          throw new BillingApiError(503, "autonomous_api_unavailable", "La API autonoma no esta configurada");
        }
        const idempotencyKey = requireIdempotencyKey(request.headers["idempotency-key"]);
        const input = await readAutonomousBillingRequest(request, { ticketLimitBytes });
        const upload = await ticketUpload.save({
          uid: identity.uid,
          ticket: input.ticket,
          idempotencyKey,
        });
        const result = await repository.createAutonomousJob({
          uid: identity.uid,
          body: {
            ticketFileUrl: upload.downloadUrl,
            taxProfile: input.taxProfile,
            ...(input.rfcReceptor ? { rfcReceptor: input.rfcReceptor } : {}),
          },
          idempotencyKey,
        });
        await notifyDispatch(dispatchJobSignal, {
          uid: identity.uid,
          jobId: result.job.id,
          lane: "ocr",
          generation: "created-v2",
          reason: result.reused ? "api_v2_job_reused" : "api_v2_job_created",
        }, logger);
        response.setHeader("Location", `/v2/billing/jobs/${result.job.id}`);
        sendJson(response, 202, {
          data: projectPublicBillingJob(result.job),
          meta: {
            requestId,
            reused: result.reused,
            uploadReused: upload.reused,
            apiVersion: apiVersionV2,
          },
        });
        return;
      }

      if (route.name === "get_job") {
        const job = await repository.getJob({ uid: identity.uid, jobId: route.jobId });
        if (!job) throw notFound("El job indicado no existe");
        sendJson(response, 200, {
          data: projectPublicBillingJob(job),
          meta: { requestId, apiVersion: route.version === "v2" ? apiVersionV2 : apiVersionV1 },
        });
        return;
      }

      if (route.name === "list_events") {
        const events = await repository.listJobEvents({
          uid: identity.uid,
          jobId: route.jobId,
          limit: url.searchParams.get("limit"),
        });
        sendJson(response, 200, {
          data: events.map(projectPublicBillingEvent),
          meta: { requestId, apiVersion: route.version === "v2" ? apiVersionV2 : apiVersionV1 },
        });
        return;
      }

      if (route.name === "create_command") {
        const body = await readJsonBody(request, bodyLimitBytes);
        if (route.version === "v2" && body.type !== "request_capa_c_resume") {
          throw new BillingApiError(
            400,
            "unsupported_v2_command",
            "V2 solo acepta request_capa_c_resume; el OCR no requiere confirmacion",
          );
        }
        const commandIdempotencyKey = route.version === "v2"
          ? requireIdempotencyKey(request.headers["idempotency-key"])
          : request.headers["idempotency-key"] ?? null;
        const result = await repository.createCommand({
          uid: identity.uid,
          jobId: route.jobId,
          body,
          idempotencyKey: commandIdempotencyKey,
        });
        await notifyDispatch(dispatchCommandSignal, {
          uid: identity.uid,
          commandId: result.command.id,
          jobId: result.command.jobId,
        }, logger);
        sendJson(response, 202, {
          data: {
            id: result.command.id,
            jobId: result.command.jobId,
            type: result.command.type,
            status: result.command.status,
            requestedAt: result.command.requestedAt ?? null,
          },
          meta: {
            requestId,
            reused: result.reused,
            apiVersion: route.version === "v2" ? apiVersionV2 : apiVersionV1,
          },
        });
        return;
      }

      throw notFound("Endpoint no encontrado");
    } catch (error) {
      const apiError = normalizeApiError(error);
      const logFailure = apiError.status >= 500 ? logger?.error : logger?.warn;
      logFailure?.("Billing API request failed.", {
        requestId,
        method: request.method,
        path: request.url,
        status: apiError.status,
        code: apiError.code,
        ...(apiError.status >= 500 ? { internalError: buildInternalErrorDiagnostic(error) } : {}),
      });
      sendJson(response, apiError.status, {
        error: {
          code: apiError.code,
          message: apiError.message,
          ...(apiError.details !== undefined ? { details: apiError.details } : {}),
          requestId,
        },
      });
    } finally {
      logger?.info?.("Billing API request completed.", {
        requestId,
        method: request.method,
        path: request.url,
        durationMs: Date.now() - startedAt,
        status: response.statusCode,
      });
    }
  };
}

async function notifyDispatch(dispatch, payload, logger) {
  if (typeof dispatch !== "function") {
    return;
  }

  try {
    await dispatch(payload);
  } catch (error) {
    logger?.warn?.("Billing queue dispatch failed; Firestore reconciliation will recover it.", {
      jobId: payload.jobId ?? null,
      commandId: payload.commandId ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function createMemoryRateLimiter({ limit = 120, windowMs = 60_000, maxKeys = 10_000 } = {}) {
  const entries = new Map();

  return {
    consume(key, now = Date.now()) {
      let entry = entries.get(key);
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs };
      }
      entry.count += 1;
      entries.set(key, entry);

      if (entries.size > maxKeys) {
        for (const [entryKey, value] of entries) {
          if (value.resetAt <= now || entries.size > maxKeys) entries.delete(entryKey);
          if (entries.size <= maxKeys) break;
        }
      }

      return {
        allowed: entry.count <= limit,
        limit,
        remaining: Math.max(0, limit - entry.count),
        retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
      };
    },
  };
}

async function authenticateRequest(request, verifyIdToken, verifyServiceToken = null) {
  const authorization = clean(request.headers.authorization);
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) throw unauthorized();

  if (typeof verifyServiceToken === "function") {
    try {
      const serviceIdentity = await verifyServiceToken(match[1]);
      if (clean(serviceIdentity?.uid)) return serviceIdentity;
    } catch {
      // Continue with Firebase so a malformed service-token attempt cannot disable Firebase auth.
    }
  }

  try {
    const decoded = await verifyIdToken(match[1]);
    if (!clean(decoded?.uid)) throw new Error("missing uid");
    return decoded;
  } catch {
    throw unauthorized("Credencial de acceso ausente o invalida");
  }
}

function matchRoute(method, pathname) {
  if (method === "POST" && pathname === "/v1/billing/jobs") return { name: "create_job", version: "v1" };
  if (method === "POST" && pathname === "/v2/billing/jobs") {
    return { name: "create_autonomous_job", version: "v2" };
  }

  const events = /^\/(v1|v2)\/billing\/jobs\/([A-Za-z0-9_-]{1,128})\/events$/.exec(pathname);
  if (method === "GET" && events) return { name: "list_events", version: events[1], jobId: events[2] };

  const commands = /^\/(v1|v2)\/billing\/jobs\/([A-Za-z0-9_-]{1,128})\/commands$/.exec(pathname);
  if (method === "POST" && commands) return { name: "create_command", version: commands[1], jobId: commands[2] };

  const job = /^\/(v1|v2)\/billing\/jobs\/([A-Za-z0-9_-]{1,128})$/.exec(pathname);
  if (method === "GET" && job) return { name: "get_job", version: job[1], jobId: job[2] };

  return null;
}

function requireIdempotencyKey(value) {
  const key = clean(value);
  if (!key) {
    throw new BillingApiError(
      400,
      "missing_idempotency_key",
      "Idempotency-Key es obligatorio al subir un ticket",
    );
  }
  if (key.length > 128 || !/^[\x21-\x7E]+$/.test(key)) {
    throw new BillingApiError(
      400,
      "invalid_idempotency_key",
      "Idempotency-Key debe contener hasta 128 caracteres ASCII sin espacios",
    );
  }
  return key;
}

function applyCors(request, response, allowedOriginSet) {
  const origin = clean(request.headers.origin);
  if (!origin) return;
  if (!allowedOriginSet.has(origin)) throw forbidden("Origen web no permitido");

  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization,Content-Type,Idempotency-Key,X-Request-Id",
  );
  response.setHeader("Access-Control-Max-Age", "600");
}

async function readJsonBody(request, limitBytes) {
  const contentType = clean(request.headers["content-type"]).toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new BillingApiError(415, "unsupported_media_type", "Se requiere Content-Type application/json");
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) {
      throw new BillingApiError(413, "payload_too_large", "La solicitud excede el limite permitido");
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BillingApiError(400, "invalid_json", "El cuerpo JSON no es valido");
  }
}

function normalizeApiError(error) {
  if (error instanceof BillingApiError) return error;
  return new BillingApiError(500, "internal_error", "Ocurrio un error interno");
}

function buildInternalErrorDiagnostic(error) {
  if (!(error instanceof Error)) {
    return { name: "UnknownError", message: clean(error).slice(0, 300) || "unknown" };
  }
  return {
    name: clean(error.name) || "Error",
    code: clean(error.code) || null,
    message: clean(error.message).replace(/[\r\n]+/g, " ").slice(0, 300) || "unknown",
  };
}

function sendJson(response, status, payload, headersOnly = false) {
  if (response.headersSent) return;
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(headersOnly ? undefined : body);
}

function clean(value) {
  return String(value ?? "").trim();
}
