import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runInteractiveCheckpoint } from "../user-action/interactive-checkpoint-runner.mjs";

const args = parseArgs(process.argv.slice(2));

if (!args.fixture && !args.checkpoint) {
  throw new Error("Missing --fixture=path or --checkpoint=path");
}

const fixture = args.fixture ? await readJson(args.fixture) : {};
  const taxProfile = fixture.taxProfile ?? (await readJson(args.profile ?? "data/tax-profiles/sample.json").catch(() => ({})));
const candidate = args.candidate ? await readJson(args.candidate) : null;
const userActionPayload = args.checkpoint ? await readJson(args.checkpoint) : null;
const checkpoint =
  userActionPayload?.userAction?.checkpoint ??
  userActionPayload?.checkpoint ??
  buildCheckpointFromFixture(fixture, candidate?.template);

const result = await runInteractiveCheckpoint({
  checkpoint,
  template: candidate?.template ?? null,
  fixture,
  taxProfile,
  approveFinalSubmit: args["approve-final-submit"] !== "false",
  headless: args.headless === "true",
  autoSubmitAfterUser: args["auto-submit-after-user"] !== "false",
  waitForUser: args["wait-for-user"] !== "false",
  runId: args.id ?? fixture.id ?? userActionPayload?.id ?? "capa_c_interactive",
});

console.log(JSON.stringify(result, null, 2));

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

function buildCheckpointFromFixture(fixture, template) {
  return {
    kind: "portal_checkpoint.v1",
    portalUrl: fixture.portalUrl ?? template?.portalUrl ?? null,
    currentUrl: null,
    templateId: template?.id ?? null,
    portalFamily: template?.portalFamily ?? null,
    portalName: template?.name ?? null,
    rfcEmisor: fixture.rfcEmisor ?? fixture.ocrCandidates?.rfc?.[0] ?? null,
    ticketData: {
      folio: fixture.folio ?? fixture.ocrCandidates?.folio ?? null,
      fecha: fixture.fecha ?? fixture.ocrCandidates?.fecha ?? null,
      monto: fixture.monto ?? fixture.ocrCandidates?.monto ?? fixture.ocrCandidates?.total ?? null,
      permisoCre: fixture.permisoCre ?? fixture.ocrCandidates?.permisoCre ?? null,
      codigoFacturacion:
        fixture.codigoFacturacion ??
        fixture.ocrCandidates?.codigoFacturacion ??
        fixture.ocrCandidates?.ticketId ??
        null,
      estacionCodigo: fixture.estacionCodigo ?? fixture.ocrCandidates?.estacionCodigo ?? null,
      estacionNombre: fixture.estacionNombre ?? fixture.ocrCandidates?.estacionNombre ?? null,
      sucursal: fixture.sucursal ?? fixture.ocrCandidates?.sucursal ?? fixture.ocrCandidates?.tienda ?? null,
      serie: fixture.serie ?? fixture.ocrCandidates?.serie ?? null,
      token: fixture.token ?? fixture.ocrCandidates?.token ?? null,
      terminal: fixture.terminal ?? fixture.ocrCandidates?.terminal ?? null,
      webId: fixture.webId ?? fixture.ocrCandidates?.webId ?? null,
    },
    taxProfileId: fixture.taxProfileId ?? null,
    reason: "manual_portal_required",
  };
}

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      continue;
    }
    const [key, ...valueParts] = arg.slice(2).split("=");
    parsed[key] = valueParts.length ? valueParts.join("=") : "true";
  }
  return parsed;
}
