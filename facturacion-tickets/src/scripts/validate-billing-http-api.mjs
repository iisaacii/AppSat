import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  createBillingApiHandler,
  createMemoryRateLimiter,
} from "../api/billing-api-app.mjs";
import {
  buildBillingApiResourceId,
  validateBillingApiCommandInput,
  validateBillingApiCreateJobInput,
} from "../api/billing-api-repository.mjs";
import { projectPublicBillingJob } from "../api/public-job-view.mjs";

const calls = [];
const dispatches = [];
const jobs = new Map([
  [
    "job_existing",
    {
      id: "job_existing",
      status: "ocr_review_required",
      workflowStage: "ocr",
      statusMessage: "Revisa los datos",
      rfcEmisor: "AAA010101AAA",
      rfcReceptor: "XAXX010101000",
      monto: 100,
      userAction: { reason: "ocr_review_required" },
      _firestorePath: "must/not/leak",
    },
  ],
]);
const repository = {
  async createJob(input) {
    calls.push({ method: "createJob", input });
    const job = {
      id: "job_created",
      status: "pending",
      workflowStage: "ocr",
      statusMessage: "Ticket recibido",
    };
    jobs.set(job.id, job);
    return { job, reused: false };
  },
  async getJob({ uid, jobId }) {
    calls.push({ method: "getJob", uid, jobId });
    return jobs.get(jobId) ?? null;
  },
  async listJobEvents({ uid, jobId, limit }) {
    calls.push({ method: "listJobEvents", uid, jobId, limit });
    return [{ id: "event_1", type: "created", message: "Ticket recibido" }];
  },
  async createCommand(input) {
    calls.push({ method: "createCommand", input });
    return {
      reused: false,
      command: {
        id: "cmd_1",
        jobId: input.jobId,
        type: input.body.type,
        status: "pending",
        requestedAt: "2026-08-27T12:00:00.000Z",
      },
    };
  },
};

const handler = createBillingApiHandler({
  repository,
  verifyIdToken: async (token) => {
    if (token !== "valid-token") throw new Error("invalid token");
    return { uid: "user_123", email: "user@example.com" };
  },
  allowedOrigins: ["https://appsat-dev.web.app"],
  rateLimiter: createMemoryRateLimiter({ limit: 20 }),
  dispatchJobSignal: async (payload) => dispatches.push({ kind: "job", payload }),
  dispatchCommandSignal: async (payload) => dispatches.push({ kind: "command", payload }),
});
const server = createServer(handler);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  for (const healthPath of ["/health", "/healthz"]) {
    const health = await fetch(`${baseUrl}${healthPath}`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).version, "billing-http.v1");
  }

  const unauthenticated = await fetch(`${baseUrl}/v1/billing/jobs/job_existing`);
  assert.equal(unauthenticated.status, 401);

  const invalidToken = await apiFetch("/v1/billing/jobs/job_existing", {
    token: "wrong-token",
  });
  assert.equal(invalidToken.status, 401);

  const forbiddenOrigin = await apiFetch("/v1/billing/jobs/job_existing", {
    origin: "https://evil.example",
  });
  assert.equal(forbiddenOrigin.status, 403);

  const preflight = await fetch(`${baseUrl}/v1/billing/jobs`, {
    method: "OPTIONS",
    headers: { Origin: "https://appsat-dev.web.app" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://appsat-dev.web.app");

  const create = await apiFetch("/v1/billing/jobs", {
    method: "POST",
    idempotencyKey: "upload-123",
    body: {
      ticketFileUrl:
        "https://firebasestorage.googleapis.com/v0/b/appsat-dev.firebasestorage.app/o/billing-lab%2Ftickets%2Fuser_123%2Fticket.jpg?alt=media",
      taxProfileId: "billing_lab_default",
    },
  });
  assert.equal(create.status, 202);
  assert.equal(create.headers.get("location"), "/v1/billing/jobs/job_created");
  assert.equal((await create.json()).data.id, "job_created");
  const createCall = calls.find((call) => call.method === "createJob");
  assert.equal(createCall.input.uid, "user_123");
  assert.equal(createCall.input.idempotencyKey, "upload-123");
  assert.deepEqual(dispatches[0], {
    kind: "job",
    payload: {
      uid: "user_123",
      jobId: "job_created",
      lane: "ocr",
      generation: "created",
      reason: "api_job_created",
    },
  });

  const get = await apiFetch("/v1/billing/jobs/job_existing");
  assert.equal(get.status, 200);
  const getPayload = await get.json();
  assert.equal(getPayload.data.needsUserAction, true);
  assert.equal(getPayload.data.ticket.monto, 100);
  assert.equal(Object.hasOwn(getPayload.data, "_firestorePath"), false);

  const events = await apiFetch("/v1/billing/jobs/job_existing/events?limit=8");
  assert.equal(events.status, 200);
  assert.equal((await events.json()).data[0].type, "created");

  const command = await apiFetch("/v1/billing/jobs/job_existing/commands", {
    method: "POST",
    idempotencyKey: "confirm-123",
    body: {
      type: "confirm_ocr",
      payload: { correction: { rfcEmisor: "AAA010101AAA", monto: 100 } },
    },
  });
  assert.equal(command.status, 202);
  assert.equal((await command.json()).data.type, "confirm_ocr");
  assert.deepEqual(dispatches[1], {
    kind: "command",
    payload: {
      uid: "user_123",
      commandId: "cmd_1",
      jobId: "job_existing",
    },
  });

  const missing = await apiFetch("/v1/billing/jobs/job_missing");
  assert.equal(missing.status, 404);

  const wrongContentType = await fetch(`${baseUrl}/v1/billing/jobs`, {
    method: "POST",
    headers: { Authorization: "Bearer valid-token", "Content-Type": "text/plain" },
    body: "{}",
  });
  assert.equal(wrongContentType.status, 415);

  assert.deepEqual(validateBillingApiCreateJobInput({}), ["missing ticketFileUrl"]);
  assert.match(
    validateBillingApiCreateJobInput({ ticketFileUrl: "x", uid: "attacker" })[0],
    /unexpected fields: uid/,
  );
  assert.equal(
    validateBillingApiCommandInput({ type: "confirm_ocr", payload: {} }).length,
    0,
  );
  assert.equal(
    buildBillingApiResourceId("job", "user_123", "same-key"),
    buildBillingApiResourceId("job", "user_123", "same-key"),
  );
  assert.notEqual(
    buildBillingApiResourceId("job", "user_123", "same-key"),
    buildBillingApiResourceId("job", "other_user", "same-key"),
  );

  const projected = projectPublicBillingJob({ status: "completed", resultXmlUrl: "https://x" });
  assert.equal(projected.isTerminal, true);
  assert.equal(projected.pollAfterMs, 0);

  const limiter = createMemoryRateLimiter({ limit: 1, windowMs: 1000 });
  assert.equal(limiter.consume("user", 0).allowed, true);
  assert.equal(limiter.consume("user", 1).allowed, false);

  console.log("Billing HTTP API validation passed.");
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function apiFetch(path, { method = "GET", token = "valid-token", origin = null, idempotencyKey = null, body = null } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (origin) headers.Origin = origin;
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  if (body !== null) headers["Content-Type"] = "application/json";

  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body !== null ? { body: JSON.stringify(body) } : {}),
  });
}
