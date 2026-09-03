import assert from "node:assert/strict";
import { getFirebaseDb } from "../config/firebase.mjs";
import { BillingApiError } from "../api/api-error.mjs";
import { createFirestoreBillingApiRepository } from "../api/billing-api-repository.mjs";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("FIRESTORE_EMULATOR_HOST is required for this validation");
}

const uid = "api_test_user";
const otherUid = "api_other_user";
const db = getFirebaseDb();
const userRef = db.doc(`AppSat/app/users/${uid}`);
const profileRef = userRef.collection("contribuyentes").doc("billing_lab_default");
const repository = createFirestoreBillingApiRepository({ db });
const ticketUrl =
  "https://firebasestorage.googleapis.com/v0/b/appsat-dev.firebasestorage.app/o/" +
  `billing-lab%2Ftickets%2F${uid}%2Fticket-api-test.jpg?alt=media`;
const autonomousTicketUrl =
  "https://firebasestorage.googleapis.com/v0/b/appsat-dev.firebasestorage.app/o/" +
  `billing-api%2Ftickets%2F${uid}%2Fticket-api-v2-test.jpg?alt=media`;
const autonomousTaxProfile = {
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

await profileRef.set({
  uid,
  rfc: "XAXX010101000",
  nombre: "PERSONA CONTRIBUYENTE DEMO",
  regimenesFiscales: ["605 - Sueldos y Salarios e Ingresos Asimilados a Salarios"],
  email: "pruebas@appsat.dev",
  usoCfdi: "S01 - Sin efectos fiscales",
  codigoPostal: "54040",
  calle: "CAOBA",
  ext: "23",
  int: "",
  colonia: "VALLE DE LOS PINOS",
  municipio: "TLALNEPANTLA DE BAZ",
  estado: "MEXICO",
  pais: "MEXICO",
});

const created = await repository.createJob({
  uid,
  idempotencyKey: "job-network-retry-1",
  body: { ticketFileUrl: ticketUrl, taxProfileId: "billing_lab_default" },
});
assert.equal(created.reused, false);
assert.equal(created.job.status, "pending");
assert.equal(created.job.uid, uid);
assert.equal(created.job.taxProfile.rfc, "XAXX010101000");
assert.equal(created.job.apiVersion, "billing-http.v1");

const repeated = await repository.createJob({
  uid,
  idempotencyKey: "job-network-retry-1",
  body: { ticketFileUrl: ticketUrl, taxProfileId: "billing_lab_default" },
});
assert.equal(repeated.reused, true);
assert.equal(repeated.job.id, created.job.id);

const autonomous = await repository.createAutonomousJob({
  uid,
  idempotencyKey: "job-v2-network-retry-1",
  body: {
    ticketFileUrl: autonomousTicketUrl,
    taxProfile: autonomousTaxProfile,
  },
});
assert.equal(autonomous.reused, false);
assert.equal(autonomous.job.status, "pending");
assert.equal(autonomous.job.processingMode, "autonomous");
assert.equal(autonomous.job.portalFinalSubmitApproved, true);
assert.equal(autonomous.job.apiVersion, "billing-http.v2");
assert.equal(autonomous.job.taxProfile.rfc, autonomousTaxProfile.rfc);

const repeatedAutonomous = await repository.createAutonomousJob({
  uid,
  idempotencyKey: "job-v2-network-retry-1",
  body: {
    ticketFileUrl: autonomousTicketUrl,
    taxProfile: autonomousTaxProfile,
  },
});
assert.equal(repeatedAutonomous.reused, true);
assert.equal(repeatedAutonomous.job.id, autonomous.job.id);

await assert.rejects(
  repository.createJob({
    uid,
    idempotencyKey: "job-network-retry-1",
    body: {
      ticketFileUrl: ticketUrl.replace("ticket-api-test.jpg", "different-ticket.jpg"),
      taxProfileId: "billing_lab_default",
    },
  }),
  (error) => error instanceof BillingApiError && error.code === "idempotency_conflict",
);

assert.equal((await repository.getJob({ uid, jobId: created.job.id })).id, created.job.id);
assert.equal(await repository.getJob({ uid: otherUid, jobId: created.job.id }), null);

await userRef.collection("facturaJobs").doc(created.job.id).update({
  status: "ocr_review_required",
  workflowStage: "ocr",
  userAction: { reason: "ocr_review_required" },
});

const command = await repository.createCommand({
  uid,
  jobId: created.job.id,
  idempotencyKey: "confirm-ocr-network-retry-1",
  body: {
    type: "confirm_ocr",
    payload: {
      correction: {
        rfcEmisor: "AAA010101AAA",
        folio: "12345",
        fecha: "2026-08-27",
        monto: 100,
      },
    },
  },
});
assert.equal(command.reused, false);
assert.equal(command.command.status, "pending");

const repeatedCommand = await repository.createCommand({
  uid,
  jobId: created.job.id,
  idempotencyKey: "confirm-ocr-network-retry-1",
  body: {
    type: "confirm_ocr",
    payload: {
      correction: {
        rfcEmisor: "AAA010101AAA",
        folio: "12345",
        fecha: "2026-08-27",
        monto: 100,
      },
    },
  },
});
assert.equal(repeatedCommand.reused, true);

const events = await repository.listJobEvents({ uid, jobId: created.job.id, limit: 10 });
assert.equal(events.length, 1);
assert.equal(events[0].type, "created");

await assert.rejects(
  repository.createJob({
    uid: "profile_missing_user",
    idempotencyKey: "missing-profile",
    body: {
      ticketFileUrl:
        "https://firebasestorage.googleapis.com/v0/b/appsat-dev.firebasestorage.app/o/" +
        "billing-lab%2Ftickets%2Fprofile_missing_user%2Fticket.jpg?alt=media",
      taxProfileId: "missing",
    },
  }),
  (error) => error instanceof BillingApiError && error.code === "tax_profile_not_found",
);

console.log("BILLING_HTTP_API_FIRESTORE_VALIDATION_OK");
