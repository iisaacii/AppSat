import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { runAiNavigationFallback } from "../ai-navigation/ai-navigation.service.mjs";

process.env.AI_NAVIGATOR_MODE = process.argv.includes("--gemini")
  ? "gemini"
  : process.env.AI_NAVIGATOR_MODE ?? "mock";

if (process.argv.includes("--allow-final-submit")) {
  process.env.AI_NAVIGATOR_ALLOW_FINAL_SUBMIT = "true";
  process.env.AI_NAVIGATOR_MAX_TURNS = process.env.AI_NAVIGATOR_MAX_TURNS ?? "6";
}

const approveFinalSubmit = process.argv.includes("--approve-final-submit");

const fixturePath = resolve("src/portals/fixtures/oxxo-real-validation-portal.html");
const result = await runAiNavigationFallback({
  job: {
    id: "ai_fixture_job",
    uid: "demo_user",
    portalUrl: pathToFileURL(fixturePath).href,
    rfcReceptor: "XAXX010101000",
    portalFinalSubmitApproved: approveFinalSubmit,
    taxProfile: {
      rfc: "XAXX010101000",
      legalName: "PERSONA CONTRIBUYENTE DEMO",
      email: "pruebas@appsat.dev",
      fiscalRegime: "605 - Sueldos y Salarios e Ingresos Asimilados a Salarios",
      cfdiUse: "S01 - Sin efectos fiscales",
      postalCode: "54040",
      street: "CAOBA",
      exteriorNumber: "23",
      interiorNumber: "",
      neighborhood: "VALLE DE LOS PINOS",
      municipality: "TLALNEPANTLA DE BAZ",
      state: "MEXICO",
      country: "MEXICO",
    },
  },
  extracted: {
    rfcEmisor: "CCO8605231N4",
    folio: "357057",
    fecha: "2026-03-28",
    monto: 343,
    ocrCandidates: {
      ticketId: "10MON50RCM2",
    },
  },
  template: null,
  context: {},
  failure: {
    type: "fixture_probe",
    reason: "template_missing",
  },
});

console.log(JSON.stringify(result, null, 2));
