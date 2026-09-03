import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildTicketDictionary } from "../b2-lab/b2-runner.mjs";
import { buildB2RepairActions, validateB2FieldValues } from "../b2-lab/b2-semantic-validation.mjs";

const restaurantFixture = JSON.parse(
  await readFile(resolve("data/stagehand-fixtures/restaurante-save-ticket.json"), "utf8"),
);
const ticket = buildTicketDictionary({
  rfcEmisor: restaurantFixture.rfcEmisor,
  folio: restaurantFixture.folio,
  fecha: restaurantFixture.fecha,
  monto: restaurantFixture.monto,
  ocrCandidates: restaurantFixture.ocrCandidates,
});
const taxProfile = {
  rfc: "XAXX010101000",
  email: "pruebas@easysat.dev",
  postalCode: "54040",
};

assertEqual(ticket.codigoFacturacion, "18097GER3YWFL", "ticket.codigoFacturacion");
assertEqual(ticket.folio, "17480", "ticket.folio");

const mismatchState = {
  inputs: [
    {
      kind: "input",
      selector: '[id="CodigoUnicoTicket"]',
      id: "CodigoUnicoTicket",
      label: "Codigo de facturacion | Codigo Unico",
      value: "17480",
      enabled: true,
      required: true,
    },
    {
      kind: "input",
      selector: '[id="FolioTicket"]',
      id: "FolioTicket",
      label: "Folio",
      value: "17480",
      enabled: true,
      required: true,
    },
  ],
  selects: [],
};
const mismatch = validateB2FieldValues(mismatchState, { ticket, taxProfile });

assertEqual(mismatch.ok, false, "mismatch validation should fail");
assertEqual(mismatch.issues[0]?.valueKey, "ticket.codigoFacturacion", "mismatch repair valueKey");
assertEqual(buildB2RepairActions(mismatch.issues)[0]?.valueKey, "ticket.codigoFacturacion", "repair action valueKey");

const validState = {
  ...mismatchState,
  inputs: mismatchState.inputs.map((input) =>
    input.id === "CodigoUnicoTicket" ? { ...input, value: "18097GER3YWFL" } : input,
  ),
};
const valid = validateB2FieldValues(validState, { ticket, taxProfile });
assertEqual(valid.ok, true, "valid state should pass");

const oxxoTicket = {
  folio: "357057",
  idVenta: "10MON50RCM2",
  fecha: "2026-03-28",
  monto: 343,
};
const oxxoState = {
  inputs: [
    {
      kind: "input",
      selector: '[id="form:fecha_input"]',
      id: "form:fecha_input",
      label: "Fecha de venta*",
      value: "",
      enabled: true,
      readonly: true,
    },
    {
      kind: "input",
      selector: '[id="form:folio"]',
      id: "form:folio",
      label: "Folio de venta*",
      value: "357057",
      enabled: true,
    },
    {
      kind: "input",
      selector: '[id="form:venta"]',
      id: "form:venta",
      label: "ID de venta*",
      value: "10MON50RCM2",
      enabled: true,
    },
    {
      kind: "input",
      selector: '[id="form:total"]',
      id: "form:total",
      label: "Total (2 Decimales)*",
      value: "343",
      enabled: true,
    },
  ],
  selects: [],
};
const oxxoPreClick = validateB2FieldValues(oxxoState, {
  ticket: oxxoTicket,
  taxProfile,
  includeEmptyIssues: true,
  scope: "ticket",
});

assertEqual(oxxoPreClick.ok, false, "oxxo pre-click should catch missing date");
assertEqual(oxxoPreClick.issues[0]?.valueKey, "ticket.fecha", "oxxo missing date valueKey");
assertEqual(buildB2RepairActions(oxxoPreClick.issues)[0]?.type, "setValue", "oxxo readonly date repair action");
assertEqual(
  oxxoPreClick.checked.find((item) => item.selector === '[id="form:folio"]')?.valueKey,
  "ticket.folio",
  "oxxo folio should not map to idVenta",
);
assertEqual(
  oxxoPreClick.checked.find((item) => item.selector === '[id="form:total"]')?.valueKey,
  "ticket.monto",
  "oxxo total should not map to idVenta",
);

console.log("B2 lab validation passed.");

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
