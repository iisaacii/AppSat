import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import firebase from "firebase/compat/app";
import "firebase/compat/firestore";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";

const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = resolve(serviceRoot, "..");
const projectId = "demo-appsat-rules-test";
const bucketUrl = `gs://${projectId}.appspot.com`;
const ownerUid = "billing_owner";
const otherUid = "billing_other";
const jobId = "job_security_test";
const jobPath = `AppSat/app/users/${ownerUid}/facturaJobs/${jobId}`;

const testEnvironment = await initializeTestEnvironment({
  projectId,
  firestore: {
    rules: await readFile(resolve(repositoryRoot, "firestore.rules"), "utf8"),
  },
  storage: {
    rules: await readFile(resolve(repositoryRoot, "storage.rules"), "utf8"),
  },
});

try {
  await testEnvironment.clearFirestore();
  await testEnvironment.clearStorage();

  await validateFirestoreIsolation();
  await validateStorageIsolation();
  await validateWorkerCommandApplication();
  await validateWorkerLeaseFencing();
  await validateSharedPortalKnowledge();
  await validateRetentionMaintenance();

  console.log(
    JSON.stringify(
      {
        ok: true,
        firestore: "owner isolated",
        storage: "billing-lab isolated and validated",
        commands: "worker transaction applied",
        leases: "heartbeat, portal recovery and stale-worker fencing validated",
        portalKnowledge: "backend shared registry isolated from billing clients",
        retention: "jobs, commands and inactive templates cleaned with CFDI preservation",
      },
      null,
      2,
    ),
  );
  console.log("SECURITY_RULES_VALIDATION_OK");
} finally {
  await testEnvironment.cleanup();
}

async function validateFirestoreIsolation() {
  const ownerDb = testEnvironment.authenticatedContext(ownerUid).firestore();
  const otherDb = testEnvironment.authenticatedContext(otherUid).firestore();
  const anonymousDb = testEnvironment.unauthenticatedContext().firestore();

  const serverTimestamp = firebase.firestore.FieldValue.serverTimestamp();

  await assertFails(
    ownerDb.doc(jobPath).set({
      contractVersion: "factura-job.v1",
      id: jobId,
      uid: ownerUid,
      ticketFileUrl: buildTicketDownloadUrl(ownerUid, jobId),
      rfcReceptor: "XAXX010101000",
      taxProfileId: null,
      taxProfile: null,
      source: "billing_lab",
      ocrReviewConfirmed: false,
      workflowStage: "ocr",
      status: "pending",
      statusMessage: "Ticket recibido",
      portalFinalSubmitApproved: false,
      createdAt: serverTimestamp,
      updatedAt: serverTimestamp,
    }),
  );

  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    await context.firestore().doc(jobPath).set({
      contractVersion: "factura-job.v1",
      id: jobId,
      uid: ownerUid,
      ticketFileUrl: buildTicketDownloadUrl(ownerUid, jobId),
      rfcReceptor: "XAXX010101000",
      source: "billing_api",
      ocrReviewConfirmed: false,
      workflowStage: "ocr",
      status: "pending",
      statusMessage: "Ticket recibido",
      portalFinalSubmitApproved: false,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
  });

  await assertSucceeds(ownerDb.doc(jobPath).get());
  await assertFails(otherDb.doc(jobPath).get());
  await assertFails(anonymousDb.doc(jobPath).get());
  await assertFails(otherDb.doc(jobPath).set({ uid: otherUid, status: "pending" }));
  const unsafeJobId = `${jobId}_unsafe_url`;
  await assertFails(
    ownerDb.doc(`AppSat/app/users/${ownerUid}/facturaJobs/${unsafeJobId}`).set({
      contractVersion: "factura-job.v1",
      id: unsafeJobId,
      uid: ownerUid,
      ticketFileUrl: "https://example.com/ticket.jpg",
      rfcReceptor: "XAXX010101000",
      taxProfileId: null,
      taxProfile: null,
      source: "billing_lab",
      ocrReviewConfirmed: false,
      workflowStage: "ocr",
      status: "pending",
      statusMessage: "Ticket recibido",
      portalFinalSubmitApproved: false,
      createdAt: serverTimestamp,
      updatedAt: serverTimestamp,
    }),
  );
  await assertFails(
    ownerDb.doc(`${jobPath}_mismatch`).set({
      uid: otherUid,
      status: "pending",
    }),
  );

  await assertFails(
    ownerDb.doc(`${jobPath}/events/event_owner`).set({
      actor: "lab",
      status: "ticket_uploaded",
      createdAt: new Date("2026-01-01T00:00:01.000Z"),
    }),
  );
  await assertFails(otherDb.doc(`${jobPath}/events/event_owner`).get());

  await assertFails(
    ownerDb.doc(jobPath).update({
      status: "completed",
      resultXmlUrl: "https://attacker.test/fake.xml",
    }),
  );
  await assertFails(ownerDb.doc(jobPath).delete());

  const sharedTemplatePath = "AppSat/app/billingPortalTemplates/template_security_test";
  const sharedOutcomePath = "AppSat/app/billingPortalOutcomes/outcome_security_test";
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    const adminDb = context.firestore();
    await adminDb.doc(sharedTemplatePath).set({ kind: "template_candidate" });
    await adminDb.doc(sharedOutcomePath).set({ kind: "portal_outcome" });
  });
  await assertFails(ownerDb.doc(sharedTemplatePath).get());
  await assertFails(otherDb.doc(sharedOutcomePath).get());
  await assertFails(ownerDb.doc(sharedTemplatePath).set({ kind: "tampered" }));

  const commandPath =
    `AppSat/app/users/${ownerUid}/billingJobCommands/command_owner`;
  const command = {
    version: "billing-job-command.v1",
    clientRequestId: "command_owner",
    uid: ownerUid,
    jobId,
    type: "confirm_ocr",
    payload: { correction: { monto: "100.00" } },
    status: "pending",
    requestedBy: ownerUid,
    requestedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };
  await assertFails(ownerDb.doc(commandPath).set(command));

  await assertSucceeds(
    ownerDb
      .collection(`AppSat/app/users/${ownerUid}/facturaJobs`)
      .orderBy("createdAt", "desc")
      .limit(100)
      .get(),
  );
}

async function validateStorageIsolation() {
  const ownerStorage = testEnvironment
    .authenticatedContext(ownerUid)
    .storage(bucketUrl);
  const otherStorage = testEnvironment
    .authenticatedContext(otherUid)
    .storage(bucketUrl);
  const anonymousStorage = testEnvironment
    .unauthenticatedContext()
    .storage(bucketUrl);
  const ticketPath = `billing-lab/tickets/${ownerUid}/${jobId}.jpg`;

  await assertSucceeds(
    ownerStorage.ref(ticketPath).put(new Uint8Array([0xff, 0xd8, 0xff]), {
      contentType: "image/jpeg",
    }),
  );
  await assertSucceeds(ownerStorage.ref(ticketPath).getMetadata());
  await assertFails(
    ownerStorage.ref(ticketPath).put(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), {
      contentType: "image/jpeg",
    }),
  );
  await assertFails(otherStorage.ref(ticketPath).getMetadata());
  await assertFails(anonymousStorage.ref(ticketPath).getMetadata());
  await assertFails(
    otherStorage
      .ref(`billing-lab/tickets/${ownerUid}/foreign.jpg`)
      .put(new Uint8Array([0xff, 0xd8, 0xff]), {
        contentType: "image/jpeg",
      }),
  );
  await assertFails(
    ownerStorage
      .ref(`billing-lab/tickets/${ownerUid}/invalid.jpg`)
      .put(new TextEncoder().encode("not an image"), {
        contentType: "text/plain",
      }),
  );
  await assertFails(
    ownerStorage
      .ref(`billing-lab/tickets/${ownerUid}/too-large.jpg`)
      .put(new Uint8Array(10 * 1024 * 1024 + 1), {
        contentType: "image/jpeg",
      }),
  );

  const cfdiPath = `billing-lab/cfdis/${ownerUid}/${jobId}/cfdi.xml`;
  const screenshotPath =
    `billing-lab/portal-artifacts/${ownerUid}/${jobId}/blocked.png`;

  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    const adminStorage = context.storage(bucketUrl);
    await adminStorage.ref(cfdiPath).putString("<cfdi />", "raw", {
      contentType: "application/xml",
    });
    await adminStorage
      .ref(screenshotPath)
      .put(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        contentType: "image/png",
      });
  });

  await assertSucceeds(ownerStorage.ref(cfdiPath).getMetadata());
  await assertFails(otherStorage.ref(cfdiPath).getMetadata());
  await assertFails(
    ownerStorage.ref(cfdiPath).putString("tampered", "raw", {
      contentType: "application/xml",
    }),
  );
  await assertSucceeds(ownerStorage.ref(screenshotPath).getMetadata());
  await assertFails(otherStorage.ref(screenshotPath).getMetadata());

  const unknownPath = "other-product/test/security-check.txt";
  await assertFails(
    ownerStorage.ref(unknownPath).putString("denied", "raw", {
      contentType: "text/plain",
    }),
  );
}

function buildTicketDownloadUrl(uid, id) {
  return `https://firebasestorage.googleapis.com/v0/b/appsat-dev.firebasestorage.app/o/billing-lab%2Ftickets%2F${uid}%2F${id}.jpg?alt=media&token=test-token`;
}

async function validateWorkerCommandApplication() {
  await testEnvironment.clearFirestore();
  process.env.FIREBASE_PROJECT_ID = projectId;
  process.env.GCLOUD_PROJECT = projectId;
  process.env.FIREBASE_STORAGE_BUCKET = `${projectId}.appspot.com`;

  const integrationJobId = "job_command_integration";
  const integrationJobPath =
    `AppSat/app/users/${ownerUid}/facturaJobs/${integrationJobId}`;
  const integrationCommandPath =
    `AppSat/app/users/${ownerUid}/billingJobCommands/command_integration`;

  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await db.doc(integrationJobPath).set({
      id: integrationJobId,
      uid: ownerUid,
      status: "needs_user_action",
      reason: "ocr_review_required",
      attemptCount: 2,
      claimedBy: null,
    });
    await db.doc(integrationCommandPath).set({
      version: "billing-job-command.v1",
      clientRequestId: "command_integration",
      uid: ownerUid,
      jobId: integrationJobId,
      type: "confirm_ocr",
      payload: {
        correction: {
          rfcEmisor: "ocs120223sn2",
          fecha: "2026-05-17",
          monto: "100.00",
        },
      },
      status: "pending",
      requestedBy: ownerUid,
      requestedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
  });

  const { processNextFirestoreClientCommand } = await import(
    "../jobs/firestore-job-store.mjs"
  );
  const processed = await processNextFirestoreClientCommand();
  assert.equal(processed?.status, "processed");
  assert.equal(processed?.jobId, integrationJobId);

  const ownerDb = testEnvironment.authenticatedContext(ownerUid).firestore();
  const job = await ownerDb.doc(integrationJobPath).get();

  assert.equal(job.data().status, "pending");
  assert.equal(job.data().rfcEmisor, "OCS120223SN2");
  assert.equal(job.data().monto, 100);
  assert.equal(job.data().attemptCount, 0);
}

async function validateSharedPortalKnowledge() {
  const previousMode = process.env.PORTAL_KNOWLEDGE_STORE;
  process.env.PORTAL_KNOWLEDGE_STORE = "firestore";

  try {
    const {
      degradeSharedTemplateCandidate,
      listSharedPortalOutcomes,
      listSharedTemplateCandidates,
      publishSharedTemplateCandidate,
      rememberSharedPortalOutcome,
    } = await import("../portals/portal-knowledge-repository.mjs");
    const sourceCreatedAt = "2026-08-27T12:00:00.000Z";
    const document = {
      status: "active_lab",
      source: { providerMode: "security_validation", createdAt: sourceCreatedAt },
      template: {
        schemaVersion: "portal-template.v1",
        id: "shared-registry-validation-template",
        name: "Shared Registry Validation",
        rfcEmisor: "AAA010101AAA",
        portalUrl: "https://facturacion.example.com/",
        requiredFields: [],
        steps: [],
      },
    };

    await publishSharedTemplateCandidate({
      document,
      sourcePath: "data/portal-template-candidates/shared-registry-validation.candidate.json",
    });
    let templates = await listSharedTemplateCandidates({ rfcEmisor: "AAA010101AAA" });
    assert.equal(templates.length, 1);
    assert.equal(templates[0].status, "active_lab");

    assert.equal(
      await degradeSharedTemplateCandidate({
        templateId: document.template.id,
        reason: "validation_layout_change",
      }),
      1,
    );
    templates = await listSharedTemplateCandidates({ templateId: document.template.id });
    assert.equal(templates[0].status, "degraded");

    await rememberSharedPortalOutcome({
      rfcEmisor: "AAA010101AAA",
      portalUrl: "https://facturacion.example.com/",
      reason: "captcha_required",
      status: "needs_user_action",
      statusMessage: "CAPTCHA",
      source: "security_validation",
    });
    await rememberSharedPortalOutcome({
      rfcEmisor: "AAA010101AAA",
      portalUrl: "https://facturacion.example.com/",
      reason: "captcha_required",
      status: "needs_user_action",
      statusMessage: "CAPTCHA",
      source: "security_validation",
    });
    const outcomes = await listSharedPortalOutcomes({
      rfcEmisor: "AAA010101AAA",
      portalHost: "facturacion.example.com",
    });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].failureCount, 2);
  } finally {
    if (previousMode === undefined) {
      delete process.env.PORTAL_KNOWLEDGE_STORE;
    } else {
      process.env.PORTAL_KNOWLEDGE_STORE = previousMode;
    }
  }
}

async function validateRetentionMaintenance() {
  const now = new Date("2026-08-27T12:00:00.000Z");
  const staleDate = new Date("2026-08-20T12:00:00.000Z");
  const oldDate = new Date("2026-07-01T12:00:00.000Z");
  const expirableJobPath = `AppSat/app/users/${ownerUid}/facturaJobs/job_retention_expire`;
  const processingJobPath = `AppSat/app/users/${ownerUid}/facturaJobs/job_retention_processing`;
  const staleCommandPath = `AppSat/app/users/${ownerUid}/billingJobCommands/command_retention_stale`;
  const oldCommandPath = `AppSat/app/users/${ownerUid}/billingJobCommands/command_retention_old`;
  const inactiveTemplatePath = "AppSat/app/billingPortalTemplates/template_retention_old";

  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await db.doc(expirableJobPath).set({
      id: "job_retention_expire",
      uid: ownerUid,
      status: "needs_user_action",
      workflowStage: "manual",
      updatedAt: staleDate,
      createdAt: staleDate,
    });
    await db.doc(processingJobPath).set({
      id: "job_retention_processing",
      uid: ownerUid,
      status: "portal_processing",
      workflowStage: "portal",
      updatedAt: staleDate,
      createdAt: staleDate,
    });
    await db.doc(staleCommandPath).set({
      version: "billing-job-command.v1",
      jobId: "job_retention_expire",
      status: "pending",
      requestedAt: staleDate,
    });
    await db.doc(oldCommandPath).set({
      version: "billing-job-command.v1",
      jobId: "job_retention_expire",
      status: "processed",
      requestedAt: oldDate,
      processedAt: oldDate,
    });
    await db.doc(inactiveTemplatePath).set({
      kind: "template_candidate",
      templateId: "template-retention-old",
      rfcEmisor: "AAA010101AAA",
      status: "degraded",
      activeForRouting: false,
      sourceCreatedAt: oldDate.toISOString(),
      candidate: {
        status: "degraded",
        source: { createdAt: oldDate.toISOString() },
        template: { id: "template-retention-old", rfcEmisor: "AAA010101AAA" },
      },
    });
  });

  const previousPurge = process.env.RETENTION_PURGE_ABANDONED_JOBS;
  process.env.RETENTION_PURGE_ABANDONED_JOBS = "false";

  try {
    const { runFirestoreRetentionMaintenance } = await import(
      "../maintenance/firestore-retention.service.mjs"
    );
    const result = await runFirestoreRetentionMaintenance({ execute: true, now });
    assert.equal(result.jobs.executed, 1);
    assert.equal(result.commands.executed, 2);
    assert.equal(result.templateCandidates.executed, 1);

    const ownerDb = testEnvironment.authenticatedContext(ownerUid).firestore();
    assert.equal((await ownerDb.doc(expirableJobPath).get()).data().status, "expired");
    assert.equal((await ownerDb.doc(processingJobPath).get()).data().status, "portal_processing");

    await testEnvironment.withSecurityRulesDisabled(async (context) => {
      assert.equal((await context.firestore().doc(staleCommandPath).get()).data().status, "rejected");
      assert.equal((await context.firestore().doc(oldCommandPath).get()).exists, false);
      assert.equal((await context.firestore().doc(inactiveTemplatePath).get()).exists, false);
    });
  } finally {
    if (previousPurge === undefined) {
      delete process.env.RETENTION_PURGE_ABANDONED_JOBS;
    } else {
      process.env.RETENTION_PURGE_ABANDONED_JOBS = previousPurge;
    }
  }
}

async function validateWorkerLeaseFencing() {
  await testEnvironment.clearFirestore();
  process.env.FIREBASE_PROJECT_ID = projectId;
  process.env.GCLOUD_PROJECT = projectId;

  const leaseJobId = "job_lease_fencing";
  const leaseJobPath = `AppSat/app/users/${ownerUid}/facturaJobs/${leaseJobId}`;

  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    await context.firestore().doc(leaseJobPath).set({
      id: leaseJobId,
      uid: ownerUid,
      status: "pending",
      statusMessage: "Ticket recibido",
      attemptCount: 0,
      claimedBy: null,
      claimId: null,
      leaseVersion: 0,
      heartbeatAt: null,
      leaseExpiresAt: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
  });

  const {
    appendClaimedFirestoreJobEvent,
    claimFirestoreJob,
    findPendingFirestoreJob,
    renewFirestoreJobLease,
    updateClaimedFirestoreJob,
  } = await import("../jobs/firestore-job-store.mjs");

  assert.equal(await findPendingFirestoreJob({ lane: "portal" }), null);
  const pending = await findPendingFirestoreJob({ lane: "ocr" });
  assert.equal(pending?.id, leaseJobId);

  const claimA = await claimFirestoreJob(pending, { lane: "ocr" });
  assert.ok(claimA?.claimId);
  assert.equal(claimA.leaseVersion, 1);
  assert.equal(await renewFirestoreJobLease(claimA), true);

  await appendClaimedFirestoreJobEvent(
    claimA,
    {
      type: "portal_opened",
      status: "portal_processing",
      message: "Portal abierto por worker A",
    },
    {
      status: "portal_processing",
      statusMessage: "Generando factura",
    },
  );

  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    await context.firestore().doc(leaseJobPath).update({
      leaseExpiresAt: new Date(Date.now() - 1000),
      updatedAt: new Date(),
    });
  });

  assert.equal(await findPendingFirestoreJob({ lane: "ocr" }), null);
  const expiredPortalJob = await findPendingFirestoreJob({ lane: "portal" });
  assert.equal(expiredPortalJob?.id, leaseJobId);
  assert.equal(expiredPortalJob?.status, "portal_processing");

  const claimB = await claimFirestoreJob(expiredPortalJob, { lane: "portal" });
  assert.ok(claimB?.claimId);
  assert.notEqual(claimB.claimId, claimA.claimId);
  assert.equal(claimB.leaseVersion, 2);

  await assert.rejects(
    updateClaimedFirestoreJob(claimA, { status: "completed" }),
    (error) => error?.code === "job_claim_lost",
  );
  await assert.rejects(
    appendClaimedFirestoreJobEvent(claimA, {
      type: "stale_worker_event",
      status: "completed",
      message: "Este evento no debe guardarse",
    }),
    (error) => error?.code === "job_claim_lost",
  );

  await updateClaimedFirestoreJob(claimB, {
    status: "completed",
    statusMessage: "Factura lista",
    claimedBy: null,
    claimId: null,
    heartbeatAt: null,
    leaseExpiresAt: null,
  });

  const ownerDb = testEnvironment.authenticatedContext(ownerUid).firestore();
  const completed = await ownerDb.doc(leaseJobPath).get();
  const staleEvents = await ownerDb
    .collection(`${leaseJobPath}/events`)
    .where("type", "==", "stale_worker_event")
    .get();

  assert.equal(completed.data().status, "completed");
  assert.equal(completed.data().claimId, null);
  assert.equal(staleEvents.empty, true);
}
