import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getWorkerId, getWorkerLeaseDurationMs, getWorkerMaxAttempts } from "../config/env.mjs";
import { JobClaimLostError } from "./job-claim.error.mjs";
import {
  buildClaimPresentation,
  isJobEligibleForWorkerLane,
  normalizeWorkerLane,
} from "./job-workflow.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const jobsPath = resolve(rootDir, "data/mock-jobs.json");
const eventsPath = resolve(rootDir, "data/mock-job-events.json");
const leasedStatuses = new Set(["ocr_processing", "portal_processing", "capa_c_preparing"]);
const demoTaxProfile = {
  rfc: "XAXX010101000",
  legalName: "PERSONA CONTRIBUYENTE DEMO",
  email: "pruebas@appsat.dev",
  fiscalRegime: "605 - Sueldos y Salarios e Ingresos Asimilados a Salarios",
  fiscalRegimes: ["605 - Sueldos y Salarios e Ingresos Asimilados a Salarios"],
  cfdiUse: "S01 - Sin efectos fiscales",
  postalCode: "54040",
  street: "CAOBA",
  exteriorNumber: "23",
  interiorNumber: "",
  neighborhood: "VALLE DE LOS PINOS",
  municipality: "TLALNEPANTLA DE BAZ",
  state: "MEXICO",
  country: "MEXICO",
};

const initialJobs = [
  {
    id: "job_demo_001",
    uid: "demo_user",
    ticketFileUrl: "mock://ticket-oxxo.jpg",
    rfcReceptor: "XAXX010101000",
    taxProfileId: "billing_lab_default",
    taxProfile: demoTaxProfile,
    rfcEmisor: null,
    folio: null,
    fecha: null,
    monto: null,
    status: "pending",
    statusMessage: "Ticket recibido",
    resultXmlUrl: null,
    resultPdfUrl: null,
    error: null,
    lastError: null,
    attemptCount: 0,
    claimedBy: null,
    claimId: null,
    leaseVersion: 0,
    heartbeatAt: null,
    leaseExpiresAt: null,
    retryAt: null,
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  },
];

const initialEvents = {
  job_demo_001: [
    {
      id: "event_demo_created",
      type: "created",
      status: "pending",
      message: "Job demo creado",
      actor: "seed",
      workerId: null,
      attemptCount: 0,
      metadata: { ticketFileUrl: "mock://ticket-oxxo.jpg" },
      createdAt: "2026-05-12T00:00:00.000Z",
    },
  ],
};

export async function listJobs() {
  const raw = await readFile(jobsPath, "utf8");
  return JSON.parse(raw);
}

export async function findPendingJob(options = {}) {
  const workerLane = normalizeWorkerLane(options.lane);
  const jobs = await listJobs();
  return jobs.find((job) => isClaimable(job, { lane: workerLane })) ?? null;
}

export async function claimJob(job, options = {}) {
  const workerLane = normalizeWorkerLane(options.lane);
  const jobs = await listJobs();
  const index = jobs.findIndex((item) => item.id === job.id);

  if (index === -1 || (!isClaimable(jobs[index], { lane: workerLane }))) {
    return null;
  }

  const now = new Date();
  const attemptCount = (jobs[index].attemptCount ?? 0) + 1;

  if (attemptCount > getWorkerMaxAttempts()) {
    jobs[index] = {
      ...jobs[index],
      status: "failed",
      statusMessage: "Se agotaron los intentos de procesamiento",
      error: "max_attempts_exceeded",
      claimedBy: null,
      claimId: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      retryAt: null,
      updatedAt: now.toISOString(),
    };
    await writeFile(jobsPath, `${JSON.stringify(jobs, null, 2)}\n`, "utf8");
    await appendJobEvent(job.id, {
      type: "failed",
      status: "failed",
      message: "Se agotaron los intentos de procesamiento",
      actor: "worker",
      workerId: getWorkerId(),
      attemptCount,
      metadata: { reason: "max_attempts_exceeded" },
    });
    return null;
  }

  const requestedStatus = jobs[index].status;
  const claim = buildClaimPresentation(jobs[index], workerLane);
  const claimStatus = claim.status;
  const claimId = randomUUID();
  const leaseVersion = Number(jobs[index].leaseVersion ?? 0) + 1;

  jobs[index] = {
    ...jobs[index],
    status: claimStatus,
    workflowStage: claim.workflowStage,
    requestedStatus,
    statusMessage: claim.statusMessage,
    error: null,
    attemptCount,
    claimedBy: getWorkerId(),
    claimId,
    leaseVersion,
    heartbeatAt: now.toISOString(),
    processingStartedAt: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + getWorkerLeaseDurationMs()).toISOString(),
    retryAt: null,
    updatedAt: now.toISOString(),
  };

  await writeFile(jobsPath, `${JSON.stringify(jobs, null, 2)}\n`, "utf8");
  await appendJobEvent(job.id, {
    type: "claimed",
    status: claimStatus,
    message: "Worker reclamo el job",
    actor: "worker",
    workerId: jobs[index].claimedBy,
    attemptCount,
    metadata: {
      claimId,
      leaseVersion,
      recoveredFromStatus: requestedStatus,
      leaseExpiresAt: jobs[index].leaseExpiresAt,
      workerLane: claim.lane,
      workflowStage: claim.workflowStage,
    },
  });
  return jobs[index];
}

function isClaimable(job, options = {}) {
  return (
    isJobEligibleForWorkerLane(job, options.lane) &&
    (job.status === "pending" || job.status === "capa_c_resume_requested" || isDueRetry(job) || isExpiredLease(job))
  );
}

function isDueRetry(job) {
  if (job.status !== "retry_scheduled") {
    return false;
  }

  if (!job.retryAt) {
    return true;
  }

  return new Date(job.retryAt).getTime() <= Date.now();
}

function isExpiredLease(job) {
  if (!leasedStatuses.has(job.status) || !job.leaseExpiresAt) {
    return false;
  }

  return new Date(job.leaseExpiresAt).getTime() <= Date.now();
}

export async function updateJob(jobId, patch) {
  const jobs = await listJobs();
  const index = jobs.findIndex((job) => job.id === jobId);

  if (index === -1) {
    throw new Error(`Job not found: ${jobId}`);
  }

  jobs[index] = {
    ...jobs[index],
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  await writeFile(jobsPath, `${JSON.stringify(jobs, null, 2)}\n`, "utf8");
  return jobs[index];
}

export async function updateClaimedJob(job, patch) {
  const jobs = await listJobs();
  const index = jobs.findIndex((entry) => entry.id === job.id);

  if (index === -1 || !ownsClaim(jobs[index], job)) {
    throw new JobClaimLostError(job.id);
  }

  jobs[index] = {
    ...jobs[index],
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(jobsPath, `${JSON.stringify(jobs, null, 2)}\n`, "utf8");
  return jobs[index];
}

export async function renewLease(job) {
  const jobs = await listJobs();
  const index = jobs.findIndex((entry) => entry.id === job.id);

  if (index === -1 || !ownsClaim(jobs[index], job) || !leasedStatuses.has(jobs[index].status)) {
    return false;
  }

  const now = new Date();
  jobs[index] = {
    ...jobs[index],
    heartbeatAt: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + getWorkerLeaseDurationMs()).toISOString(),
    updatedAt: now.toISOString(),
  };
  await writeFile(jobsPath, `${JSON.stringify(jobs, null, 2)}\n`, "utf8");
  return true;
}

export async function appendClaimedJobEvent(job, event, jobPatch = null) {
  const jobs = await listJobs();
  const index = jobs.findIndex((entry) => entry.id === job.id);

  if (index === -1 || !ownsClaim(jobs[index], job)) {
    throw new JobClaimLostError(job.id);
  }

  if (jobPatch) {
    jobs[index] = {
      ...jobs[index],
      ...jobPatch,
      updatedAt: new Date().toISOString(),
    };
    await writeFile(jobsPath, `${JSON.stringify(jobs, null, 2)}\n`, "utf8");
  }

  return appendJobEvent(job.id, {
    ...event,
    metadata: {
      ...(event.metadata ?? {}),
      claimId: job.claimId,
      leaseVersion: job.leaseVersion ?? null,
    },
  });
}

function ownsClaim(current, job) {
  if (!job?.claimId || current?.claimId !== job.claimId || current?.claimedBy !== job.claimedBy) {
    return false;
  }

  return job.leaseVersion == null || Number(current.leaseVersion ?? 0) === Number(job.leaseVersion);
}

export async function appendJobEvent(jobId, event) {
  const events = await listJobEvents();
  const now = new Date().toISOString();
  const nextEvent = {
    id: `event_${now.replace(/[^0-9]/g, "")}_${Math.random().toString(36).slice(2, 8)}`,
    type: event.type,
    status: event.status ?? null,
    message: event.message ?? null,
    actor: event.actor ?? "worker",
    workerId: event.workerId ?? getWorkerId(),
    attemptCount: event.attemptCount ?? null,
    metadata: event.metadata ?? {},
    createdAt: now,
  };

  events[jobId] = [...(events[jobId] ?? []), nextEvent];
  await writeFile(eventsPath, `${JSON.stringify(events, null, 2)}\n`, "utf8");
  return nextEvent;
}

export async function resetMockJobs() {
  await writeFile(jobsPath, `${JSON.stringify(initialJobs, null, 2)}\n`, "utf8");
  await writeFile(eventsPath, `${JSON.stringify(initialEvents, null, 2)}\n`, "utf8");
}

async function listJobEvents() {
  try {
    const raw = await readFile(eventsPath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}
