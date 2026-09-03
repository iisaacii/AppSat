import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  FACTURA_JOB_CONTRACT_VERSION,
  buildFacturaJobCreatePayload,
  validateFacturaJobCreatePayload,
} from "../contracts/factura-job-contract.mjs";

const profilePath =
  process.argv.find((arg) => arg.startsWith("--profile="))?.slice("--profile=".length) ??
  "data/tax-profiles/sample.json";
const uid =
  process.argv.find((arg) => arg.startsWith("--uid="))?.slice("--uid=".length) ?? "demo_user";
const ticketFileUrl =
  process.argv.find((arg) => arg.startsWith("--ticket-file-url="))?.slice("--ticket-file-url=".length) ??
  "mock://ticket-sample.jpg";

const profile = JSON.parse(await readFile(resolve(profilePath), "utf8"));
const payload = buildFacturaJobCreatePayload({
  jobId: "job_contract_001",
  uid,
  ticketFileUrl,
  taxProfile: profile,
  taxProfileId: profile.id ?? "billing_lab_default",
  source: "contract_sample",
});
const validation = validateFacturaJobCreatePayload(payload);

console.log(
  JSON.stringify(
    {
      contractVersion: FACTURA_JOB_CONTRACT_VERSION,
      validation,
      writePath: `EasySat/app/users/${uid}/facturaJobs/{jobId}`,
      storagePath: `billing-lab/tickets/${uid}/{jobId}.jpg`,
      payload,
    },
    null,
    2,
  ),
);

if (!validation.ok) process.exitCode = 1;
