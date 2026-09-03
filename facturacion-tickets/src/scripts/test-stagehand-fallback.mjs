import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runBillingOrchestrator } from "../orchestrator/billing-orchestrator.mjs";
import { buildFiscalComplianceContext } from "../fiscal/fiscal-compliance.service.mjs";

async function main() {
  const fixturePath = resolve("data/stagehand-fixtures/seven-ticket-local.json");
  const profilePath = resolve("data/tax-profiles/sample.json");

  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const taxProfile = fixture.taxProfile ?? JSON.parse(await readFile(profilePath, "utf8"));
  const fiscalCompliance = fixture.fiscalCompliance ?? buildFiscalComplianceContext(taxProfile);

  process.env.BILLING_FORCE_AI_NAVIGATION = "true";
  process.env.AI_NAVIGATOR_MODE = "gemini";

  console.log("Starting Orchestrator with Seven-Eleven ticket...");
  console.log("Stagehand enabled?", process.env.STAGEHAND_LAB_ENABLED);

  const result = await runBillingOrchestrator({
    id: "seven_test",
    ticketFileUrl: fixture.ticketImagePath ?? "mock://ticket.jpg",
    aiPortalUrl: fixture.portalUrl,
    portalFinalSubmitApproved: true,
    taxProfile,
    fiscalCompliance,
    manualOverrides: {
      rfcEmisor: fixture.rfcEmisor ?? "7EL",
      folio: fixture.folio,
      fecha: fixture.fecha,
      monto: fixture.monto,
      ocrCandidates: fixture.ocrCandidates,
    },
  }, { emit: async (event) => console.log("EVENT:", JSON.stringify(event)) });

  console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);
