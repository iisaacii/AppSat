import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createBillingApiHandler, createMemoryRateLimiter } from "../api/billing-api-app.mjs";

const calls = [];
const dispatches = [];
const repository = {
  async createAutonomousJob(input) {
    calls.push({ type: "create", input });
    return {
      reused: false,
      job: {
        id: "job_v2_created",
        status: "pending",
        workflowStage: "ocr",
        processingMode: "autonomous",
        apiVersion: "billing-http.v2",
      },
    };
  },
  async getJob({ jobId }) {
    return {
      id: jobId,
      status: "portal_processing",
      workflowStage: "portal",
      processingMode: "autonomous",
      ocrResolution: {
        status: "accepted",
        confidence: 0.91,
        candidateSets: [{ rank: 1 }, { rank: 2 }],
        unresolvedFields: [],
        providers: [{ source: "google_vision", available: true }],
      },
    };
  },
  async listJobEvents() {
    return [];
  },
  async createCommand(input) {
    calls.push({ type: "command", input });
    return {
      reused: false,
      command: {
        id: "cmd_v2_resume",
        jobId: input.jobId,
        type: input.body.type,
        status: "pending",
        requestedAt: "2026-08-31T00:00:00.000Z",
      },
    };
  },
};
const ticketUpload = {
  async save(input) {
    calls.push({ type: "upload", input });
    return {
      downloadUrl: "https://firebasestorage.googleapis.com/v0/b/appsat-dev.firebasestorage.app/o/billing-api%2Ftickets%2Fuser_123%2Fticket_1.jpg?alt=media&token=test",
      path: "billing-api/tickets/user_123/ticket_1.jpg",
      reused: false,
    };
  },
};
const handler = createBillingApiHandler({
  repository,
  ticketUpload,
  verifyIdToken: async (token) => {
    if (token !== "valid-token") throw new Error("invalid");
    return { uid: "user_123" };
  },
  verifyServiceToken: async (token) => {
    if (token !== "service-token") return null;
    return { uid: "api_external_client", authType: "service_token", clientId: "external_client" };
  },
  rateLimiter: createMemoryRateLimiter({ limit: 20 }),
  dispatchJobSignal: async (payload) => dispatches.push(payload),
});
const server = createServer(handler);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  const health = await fetch(`${baseUrl}/health`);
  const healthPayload = await health.json();
  assert.equal(healthPayload.version, "billing-http.v1");
  assert.equal(healthPayload.latestVersion, "billing-http.v2");
  assert.deepEqual(healthPayload.supportedVersions, ["billing-http.v1", "billing-http.v2"]);

  const missingKey = await fetch(`${baseUrl}/v2/billing/jobs`, {
    method: "POST",
    headers: { Authorization: "Bearer valid-token" },
    body: buildForm(),
  });
  assert.equal(missingKey.status, 400);
  assert.equal((await missingKey.json()).error.code, "missing_idempotency_key");

  const created = await fetch(`${baseUrl}/v2/billing/jobs`, {
    method: "POST",
    headers: {
      Authorization: "Bearer valid-token",
      "Idempotency-Key": "external-ticket-001",
    },
    body: buildForm(),
  });
  assert.equal(created.status, 202);
  assert.equal(created.headers.get("location"), "/v2/billing/jobs/job_v2_created");
  const createdPayload = await created.json();
  assert.equal(createdPayload.meta.apiVersion, "billing-http.v2");
  assert.equal(createdPayload.data.processingMode, "autonomous");

  const serviceTokenStatus = await fetch(`${baseUrl}/v2/billing/jobs/job_v2_created`, {
    headers: { Authorization: "Bearer service-token" },
  });
  assert.equal(serviceTokenStatus.status, 200);
  assert.equal((await serviceTokenStatus.json()).data.id, "job_v2_created");

  const uploadCall = calls.find((call) => call.type === "upload");
  assert.equal(uploadCall.input.uid, "user_123");
  assert.equal(uploadCall.input.idempotencyKey, "external-ticket-001");
  assert.equal(uploadCall.input.ticket.mimeType, "image/jpeg");
  assert.equal(uploadCall.input.ticket.buffer.subarray(3).toString("utf8"), "fake-jpeg");

  const createCall = calls.find((call) => call.type === "create");
  assert.equal(createCall.input.body.taxProfile.rfc, "XAXX010101000");
  assert.match(createCall.input.body.ticketFileUrl, /billing-api%2Ftickets/);
  assert.deepEqual(dispatches[0], {
    uid: "user_123",
    jobId: "job_v2_created",
    lane: "ocr",
    generation: "created-v2",
    reason: "api_v2_job_created",
  });

  const status = await fetch(`${baseUrl}/v2/billing/jobs/job_v2_created`, {
    headers: { Authorization: "Bearer valid-token" },
  });
  const statusPayload = await status.json();
  assert.equal(statusPayload.meta.apiVersion, "billing-http.v2");
  assert.equal(statusPayload.data.ocrResolution.status, "accepted");
  assert.equal(statusPayload.data.ocrResolution.candidateSetCount, 2);

  const unsupportedCommand = await fetch(`${baseUrl}/v2/billing/jobs/job_v2_created/commands`, {
    method: "POST",
    headers: {
      Authorization: "Bearer valid-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "confirm_ocr", payload: {} }),
  });
  assert.equal(unsupportedCommand.status, 400);
  assert.equal((await unsupportedCommand.json()).error.code, "unsupported_v2_command");
  assert.equal(calls.filter((call) => call.type === "command").length, 0);

  const resumeWithoutKey = await fetch(`${baseUrl}/v2/billing/jobs/job_v2_created/commands`, {
    method: "POST",
    headers: {
      Authorization: "Bearer valid-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "request_capa_c_resume", payload: {} }),
  });
  assert.equal(resumeWithoutKey.status, 400);
  assert.equal((await resumeWithoutKey.json()).error.code, "missing_idempotency_key");
  assert.equal(calls.filter((call) => call.type === "command").length, 0);

  const resumeCommand = await fetch(`${baseUrl}/v2/billing/jobs/job_v2_created/commands`, {
    method: "POST",
    headers: {
      Authorization: "Bearer valid-token",
      "Content-Type": "application/json",
      "Idempotency-Key": "resume-capa-c-001",
    },
    body: JSON.stringify({ type: "request_capa_c_resume", payload: {} }),
  });
  assert.equal(resumeCommand.status, 202);
  assert.equal((await resumeCommand.json()).data.type, "request_capa_c_resume");
  assert.equal(calls.filter((call) => call.type === "command").length, 1);

  const invalidImage = await fetch(`${baseUrl}/v2/billing/jobs`, {
    method: "POST",
    headers: {
      Authorization: "Bearer valid-token",
      "Idempotency-Key": "invalid-image-001",
    },
    body: buildForm({ ticketParts: ["not-a-real-jpeg"] }),
  });
  assert.equal(invalidImage.status, 415);
  assert.equal((await invalidImage.json()).error.code, "invalid_ticket_image");

  const uploadsBeforeInvalidProfile = calls.filter((call) => call.type === "upload").length;
  const invalidProfile = await fetch(`${baseUrl}/v2/billing/jobs`, {
    method: "POST",
    headers: {
      Authorization: "Bearer valid-token",
      "Idempotency-Key": "invalid-profile-001",
    },
    body: buildForm({ taxProfile: { rfc: "XAXX010101000" } }),
  });
  assert.equal(invalidProfile.status, 422);
  assert.equal((await invalidProfile.json()).error.code, "tax_profile_incomplete");
  assert.equal(calls.filter((call) => call.type === "upload").length, uploadsBeforeInvalidProfile);

  console.log("Billing HTTP API v2 validation passed.");
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function buildForm({
  ticketParts = [new Uint8Array([0xff, 0xd8, 0xff]), "fake-jpeg"],
  taxProfile = validTaxProfile(),
} = {}) {
  const form = new FormData();
  form.append("ticket", new Blob(ticketParts, { type: "image/jpeg" }), "ticket.jpg");
  form.append("taxProfile", JSON.stringify(taxProfile));
  return form;
}

function validTaxProfile() {
  return {
    rfc: "XAXX010101000",
    legalName: "PERSONA CONTRIBUYENTE DEMO",
    fiscalRegime: "605",
    cfdiUse: "S01",
    postalCode: "54000",
    street: "CALLE UNO",
    exteriorNumber: "1",
    neighborhood: "CENTRO",
    municipality: "TLALNEPANTLA",
    state: "MEXICO",
  };
}
