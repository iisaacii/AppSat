import { createHash, randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getFirestoreRoot } from "../config/env.mjs";
import { getFirebaseDb } from "../config/firebase.mjs";
import {
  buildFacturaJobCreatePayload,
  normalizeTaxProfile,
  validateFacturaJobCreatePayload,
  validateTaxProfile,
} from "../contracts/factura-job-contract.mjs";
import { normalizeStoredTaxProfile } from "../fiscal/stored-tax-profile.mjs";
import {
  BILLING_JOB_COMMAND_VERSION,
  buildBillingJobCommandTransition,
  validateBillingJobCommand,
} from "../jobs/billing-job-command.service.mjs";
import { badRequest, conflict, notFound, unprocessable } from "./api-error.mjs";
import { normalizeFirestoreValue } from "./public-job-view.mjs";

const createJobFields = new Set([
  "ticketFileUrl",
  "taxProfileId",
  "taxProfile",
  "rfcReceptor",
]);
const createCommandFields = new Set(["type", "payload"]);

export function createFirestoreBillingApiRepository({ db = getFirebaseDb() } = {}) {
  return {
    createJob: (input) => createJob(db, input, { autonomous: false }),
    createAutonomousJob: (input) => createJob(db, input, { autonomous: true }),
    getJob: (input) => getJob(db, input),
    listJobEvents: (input) => listJobEvents(db, input),
    createCommand: (input) => createCommand(db, input),
  };
}

export function validateBillingApiCreateJobInput(input, { requireTaxProfile = false } = {}) {
  const errors = validateObjectShape(input, createJobFields);

  if (!clean(input?.ticketFileUrl)) errors.push("missing ticketFileUrl");
  if (clean(input?.ticketFileUrl).length > 2048) errors.push("ticketFileUrl is too long");
  if (input?.taxProfileId != null && !isSafeId(input.taxProfileId)) {
    errors.push("taxProfileId has invalid shape");
  }
  if (input?.taxProfile != null && !isPlainObject(input.taxProfile)) {
    errors.push("taxProfile must be an object");
  }
  if (requireTaxProfile && !isPlainObject(input?.taxProfile)) {
    errors.push("taxProfile is required");
  }
  if (input?.rfcReceptor != null && clean(input.rfcReceptor).length > 13) {
    errors.push("rfcReceptor is too long");
  }

  return errors;
}

export function validateBillingApiCommandInput(input) {
  const errors = validateObjectShape(input, createCommandFields);
  if (!clean(input?.type)) errors.push("missing type");
  if (!isPlainObject(input?.payload)) errors.push("payload must be an object");
  return errors;
}

export function buildBillingApiResourceId(prefix, uid, idempotencyKey = null) {
  const key = normalizeIdempotencyKey(idempotencyKey);
  if (!key) {
    return `${prefix}_${randomUUID().replaceAll("-", "")}`;
  }

  const digest = sha256(`${uid}:${key}`).slice(0, 32);
  return `${prefix}_${digest}`;
}

async function createJob(db, { uid, body, idempotencyKey = null }, { autonomous = false } = {}) {
  const validationErrors = validateBillingApiCreateJobInput(body, { requireTaxProfile: autonomous });
  if (validationErrors.length) {
    throw badRequest("invalid_job_request", "La solicitud del job no es valida", validationErrors);
  }

  const userRef = getUserRef(db, uid);
  const taxProfileId = clean(body.taxProfileId) || (autonomous ? "api_supplied" : "billing_lab_default");
  const taxProfile = await resolveTaxProfile({ userRef, body, taxProfileId });
  const requestedRfc = clean(body.rfcReceptor).toUpperCase();

  if (requestedRfc && requestedRfc !== taxProfile.rfc) {
    throw unprocessable(
      "rfc_receptor_mismatch",
      "El RFC receptor no coincide con el perfil fiscal seleccionado",
    );
  }

  const normalizedIdempotencyKey = normalizeIdempotencyKey(idempotencyKey);
  const jobId = buildBillingApiResourceId("job", uid, normalizedIdempotencyKey);
  const requestHash = sha256(stableStringify({
    processingMode: autonomous ? "autonomous" : "interactive",
    ticketFileUrl: clean(body.ticketFileUrl),
    taxProfileId,
    taxProfile,
  }));
  const idempotencyKeyHash = normalizedIdempotencyKey ? sha256(normalizedIdempotencyKey) : null;
  const createPayload = buildFacturaJobCreatePayload({
    jobId,
    uid,
    ticketFileUrl: body.ticketFileUrl,
    taxProfile,
    taxProfileId,
    source: autonomous ? "billing_api_v2" : "billing_api",
  });
  const contractValidation = validateFacturaJobCreatePayload(createPayload);

  if (!contractValidation.ok) {
    throw unprocessable(
      "invalid_job_contract",
      "El ticket o perfil fiscal no cumplen el contrato de facturacion",
      contractValidation.errors,
    );
  }

  const storedPayload = autonomous
    ? {
        ...createPayload,
        processingMode: "autonomous",
        portalFinalSubmitApproved: true,
        ocrResolution: null,
      }
    : createPayload;

  const jobRef = userRef.collection("facturaJobs").doc(jobId);
  const eventRef = jobRef.collection("events").doc();
  let reused = false;

  await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(jobRef);
    if (existing.exists) {
      if (existing.data().apiRequestHash !== requestHash) {
        throw conflict(
          "idempotency_conflict",
          "La clave de idempotencia ya fue utilizada con otro ticket",
        );
      }
      reused = true;
      return;
    }

    transaction.set(jobRef, {
      ...storedPayload,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      apiVersion: autonomous ? "billing-http.v2" : "billing-http.v1",
      apiRequestHash: requestHash,
      ...(idempotencyKeyHash ? { apiIdempotencyKeyHash: idempotencyKeyHash } : {}),
    });
    transaction.set(eventRef, {
      id: eventRef.id,
      type: "created",
      status: "pending",
      message: autonomous ? "Ticket recibido por API autonoma" : "Ticket recibido por API",
      actor: "billing_api",
      workerId: null,
      attemptCount: 0,
      metadata: { source: autonomous ? "billing_api_v2" : "billing_api" },
      createdAt: FieldValue.serverTimestamp(),
    });
  });

  const snapshot = await jobRef.get();
  return { job: mapDocument(snapshot), reused };
}

async function getJob(db, { uid, jobId }) {
  assertSafeResourceId(jobId, "jobId");
  const snapshot = await getUserRef(db, uid).collection("facturaJobs").doc(jobId).get();
  return snapshot.exists ? mapDocument(snapshot) : null;
}

async function listJobEvents(db, { uid, jobId, limit = 20 }) {
  assertSafeResourceId(jobId, "jobId");
  const jobRef = getUserRef(db, uid).collection("facturaJobs").doc(jobId);
  const jobSnapshot = await jobRef.get();
  if (!jobSnapshot.exists) throw notFound("El job indicado no existe");

  const snapshot = await jobRef
    .collection("events")
    .orderBy("createdAt", "desc")
    .limit(Math.max(1, Math.min(50, Math.floor(Number(limit) || 20))))
    .get();

  return snapshot.docs.map(mapDocument);
}

async function createCommand(db, { uid, jobId, body, idempotencyKey = null }) {
  assertSafeResourceId(jobId, "jobId");
  const inputErrors = validateBillingApiCommandInput(body);
  if (inputErrors.length) {
    throw badRequest("invalid_command_request", "El comando no es valido", inputErrors);
  }

  const userRef = getUserRef(db, uid);
  const jobRef = userRef.collection("facturaJobs").doc(jobId);
  const normalizedIdempotencyKey = normalizeIdempotencyKey(idempotencyKey);
  const commandId = buildBillingApiResourceId("cmd", uid, normalizedIdempotencyKey);
  const commandRef = userRef.collection("billingJobCommands").doc(commandId);
  const requestHash = sha256(stableStringify({ jobId, type: body.type, payload: body.payload }));
  const command = {
    version: BILLING_JOB_COMMAND_VERSION,
    clientRequestId: commandId,
    uid,
    jobId,
    type: clean(body.type),
    payload: body.payload,
    status: "pending",
    requestedBy: uid,
    requestedAt: new Date().toISOString(),
  };
  const validationErrors = validateBillingJobCommand(command, { uid });

  if (validationErrors.length) {
    throw unprocessable(
      "invalid_billing_command",
      "El comando no cumple el contrato",
      validationErrors,
    );
  }

  let reused = false;
  await db.runTransaction(async (transaction) => {
    const [jobSnapshot, commandSnapshot] = await Promise.all([
      transaction.get(jobRef),
      transaction.get(commandRef),
    ]);

    if (!jobSnapshot.exists) throw notFound("El job indicado no existe");
    if (commandSnapshot.exists) {
      if (commandSnapshot.data().apiRequestHash !== requestHash) {
        throw conflict(
          "idempotency_conflict",
          "La clave de idempotencia ya fue utilizada con otro comando",
        );
      }
      reused = true;
      return;
    }

    const transition = buildBillingJobCommandTransition({
      job: jobSnapshot.data(),
      command,
      uid,
      serverTimestamp: FieldValue.serverTimestamp(),
    });
    if (!transition.ok) {
      const status = transition.reason === "invalid_job_state" || transition.reason === "job_already_terminal"
        ? 409
        : 422;
      throw status === 409
        ? conflict(transition.reason, transition.message)
        : unprocessable(transition.reason, transition.message);
    }

    transaction.set(commandRef, {
      ...command,
      requestedAt: FieldValue.serverTimestamp(),
      apiVersion: "billing-http.v1",
      apiRequestHash: requestHash,
    });
  });

  const snapshot = await commandRef.get();
  return { command: mapDocument(snapshot), reused };
}

async function resolveTaxProfile({ userRef, body, taxProfileId }) {
  const suppliedProfile = body.taxProfile ? normalizeTaxProfile(body.taxProfile) : null;
  let profile = suppliedProfile;

  if (!profile) {
    const snapshot = await userRef.collection("contribuyentes").doc(taxProfileId).get();
    if (!snapshot.exists) {
      throw unprocessable(
        "tax_profile_not_found",
        "No existe el perfil fiscal seleccionado",
        { taxProfileId },
      );
    }
    profile = normalizeStoredTaxProfile(snapshot.data());
  }

  if (!profile) {
    throw unprocessable("tax_profile_invalid", "El perfil fiscal seleccionado esta vacio");
  }

  const errors = validateTaxProfile(profile);
  if (errors.length) {
    throw unprocessable(
      "tax_profile_incomplete",
      "El perfil fiscal seleccionado esta incompleto",
      errors,
    );
  }

  return profile;
}

function getUserRef(db, uid) {
  const { collection, document } = getFirestoreRoot();
  return db.collection(collection).doc(document).collection("users").doc(uid);
}

function mapDocument(snapshot) {
  return normalizeFirestoreValue({ id: snapshot.id, ...(snapshot.data() ?? {}) });
}

function validateObjectShape(value, allowedFields) {
  if (!isPlainObject(value)) return ["body must be an object"];
  const unexpected = Object.keys(value).filter((key) => !allowedFields.has(key));
  return unexpected.length ? [`unexpected fields: ${unexpected.join(", ")}`] : [];
}

function assertSafeResourceId(value, label) {
  if (!isSafeId(value)) throw badRequest("invalid_resource_id", `${label} no es valido`);
}

function isSafeId(value) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(clean(value));
}

function normalizeIdempotencyKey(value) {
  const key = clean(value);
  if (!key) return null;
  if (key.length > 128 || !/^[\x21-\x7E]+$/.test(key)) {
    throw badRequest(
      "invalid_idempotency_key",
      "Idempotency-Key debe contener hasta 128 caracteres ASCII sin espacios",
    );
  }
  return key;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clean(value) {
  return String(value ?? "").trim();
}
