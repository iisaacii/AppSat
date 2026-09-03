import assert from "node:assert/strict";

process.env.WORKER_LEASE_DURATION_MS = "3000";
process.env.WORKER_HEARTBEAT_INTERVAL_MS = "1000";

const { startJobLeaseHeartbeat } = await import("../jobs/factura-job.worker.mjs");
const job = {
  id: "job_heartbeat_test",
  claimedBy: "worker-test",
  claimId: "claim-test",
  leaseVersion: 1,
};

let renewals = 0;
const heartbeat = startJobLeaseHeartbeat(
  {
    renewLease: async () => {
      renewals += 1;
      return true;
    },
  },
  job,
);

await sleep(1150);
assert.ok(renewals >= 1, "El heartbeat debe renovar el lease durante procesos largos");
assert.equal(heartbeat.hasLostClaim(), false);
await heartbeat.assertActive();
assert.ok(renewals >= 2, "La guarda previa a emitir debe renovar y validar ownership");
await heartbeat.stop();

const renewalsAfterStop = renewals;
await sleep(1100);
assert.equal(renewals, renewalsAfterStop, "El heartbeat debe detenerse al terminar el job");

const rejectedHeartbeat = startJobLeaseHeartbeat(
  { renewLease: async () => false },
  job,
);
await sleep(1150);
assert.equal(rejectedHeartbeat.hasLostClaim(), true, "Un lease rechazado debe invalidar al worker");
assert.equal(rejectedHeartbeat.signal.aborted, true, "Perder el claim debe abortar B3");
await assert.rejects(rejectedHeartbeat.assertActive(), (error) => error?.code === "job_claim_lost");
await rejectedHeartbeat.stop();

console.log(
  JSON.stringify(
    {
      ok: true,
      renewals,
      lostClaimDetected: true,
    },
    null,
    2,
  ),
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
