import assert from "node:assert/strict";
import {
  assertValidCfdiXml,
  validateCfdiXmlText,
} from "../cfdi/cfdi-validator.mjs";

const expected = {
  rfcEmisor: "OCS120223SN2",
  rfcReceptor: "XAXX010101000",
  monto: 100,
  fecha: "2026-05-17",
};
const validXml = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" Fecha="2026-05-17T20:53:00" Total="100.00">
  <cfdi:Emisor Rfc="OCS120223SN2" Nombre="OPERADORA COFFEE SHOP GARAT" />
  <cfdi:Receptor Rfc="XAXX010101000" Nombre="PERSONA CONTRIBUYENTE DEMO" />
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital UUID="11111111-2222-4333-8444-555555555555" FechaTimbrado="2026-05-17T20:54:00" />
  </cfdi:Complemento>
</cfdi:Comprobante>`;

const valid = validateCfdiXmlText({ xml: validXml, expected });
assert.equal(valid.ok, true);
assert.equal(valid.uuid, "11111111-2222-4333-8444-555555555555");
assert.equal(valid.rfcReceptor, expected.rfcReceptor);
assert.equal(valid.total, 100);

const wrongReceiver = validateCfdiXmlText({
  xml: validXml.replace(expected.rfcReceptor, "XAXX010101000"),
  expected,
});
assert.equal(wrongReceiver.ok, false);
assert.ok(wrongReceiver.errors.some((error) => error.startsWith("rfcReceptor differs")));

const wrongTotal = validateCfdiXmlText({
  xml: validXml.replace('Total="100.00"', 'Total="10.00"'),
  expected,
});
assert.equal(wrongTotal.ok, false);
assert.ok(wrongTotal.errors.some((error) => error.startsWith("total differs")));

const missingUuid = validateCfdiXmlText({
  xml: validXml.replace('UUID="11111111-2222-4333-8444-555555555555"', ""),
  expected,
});
assert.equal(missingUuid.ok, false);
assert.ok(missingUuid.errors.includes("UUID is missing"));

assert.equal(validateCfdiXmlText({ xml: "<html>Portal error</html>", expected }).ok, false);
assert.equal(validateCfdiXmlText({ xml: "<cfdi:Comprobante>", expected }).ok, false);
assert.equal(
  validateCfdiXmlText({
    xml: '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>',
    expected,
  }).ok,
  false,
);

const placeholder = "<easysatCfdiPlaceholder><job id=\"fixture\" /></easysatCfdiPlaceholder>";
assert.equal(validateCfdiXmlText({ xml: placeholder }).ok, false);
assert.equal(
  validateCfdiXmlText({ xml: placeholder, allowDevelopmentPlaceholder: true }).ok,
  true,
);
assert.throws(
  () => assertValidCfdiXml({ xml: validXml.replace(expected.rfcEmisor, "CCO8605231N4"), expected }),
  (error) => error?.code === "cfdi_validation_failed",
);

process.env.CFDI_STORAGE_MODE = "mock";
const {
  hasMaterializableCfdiAsset,
  materializeCfdiResult,
} = await import("../storage/cfdi-storage.service.mjs");
assert.equal(hasMaterializableCfdiAsset({ xmlContent: validXml }, "xml"), true);
assert.equal(hasMaterializableCfdiAsset({ xmlPath: "C:/tmp/cfdi.xml" }, "xml"), true);
assert.equal(hasMaterializableCfdiAsset({ xmlUrl: "https://example.com/cfdi.xml" }, "xml"), true);
assert.equal(hasMaterializableCfdiAsset({ xmlUrl: "playwright://storage/cfdi.xml" }, "xml"), false);
const materialized = await materializeCfdiResult({
  job: {
    id: "cfdi_validation_job",
    uid: "validation_user",
    rfcReceptor: expected.rfcReceptor,
    taxProfile: { rfc: expected.rfcReceptor },
  },
  template: { id: "validation-template", rfcEmisor: expected.rfcEmisor },
  templateResult: { xmlContent: validXml, pdfUrl: "mock://cfdi.pdf" },
  extracted: expected,
});
assert.equal(materialized.cfdiValidationResult.ok, true);
await assert.rejects(
  materializeCfdiResult({
    job: {
      id: "cfdi_validation_job_bad",
      uid: "validation_user",
      rfcReceptor: expected.rfcReceptor,
      taxProfile: { rfc: expected.rfcReceptor },
    },
    template: { id: "validation-template", rfcEmisor: expected.rfcEmisor },
    templateResult: { xmlContent: "<html>not a cfdi</html>" },
    extracted: expected,
  }),
  (error) => error?.code === "cfdi_validation_failed",
);

process.env.CFDI_STORAGE_MODE = "firebase";
process.env.PORTAL_USE_FIXTURE = "false";
await assert.rejects(
  materializeCfdiResult({
    job: {
      id: "cfdi_virtual_artifact_job",
      uid: "validation_user",
      taxProfile: { rfc: expected.rfcReceptor },
    },
    template: { id: "virtual-template", rfcEmisor: expected.rfcEmisor },
    templateResult: {
      xmlUrl: "playwright://storage/cfdis/virtual.xml",
      pdfUrl: "playwright://storage/cfdis/virtual.pdf",
    },
    extracted: expected,
  }),
  (error) => error?.code === "cfdi_artifact_missing" && error?.kind === "xml",
);
process.env.CFDI_STORAGE_MODE = "mock";

console.log(
  JSON.stringify(
    {
      ok: true,
      valid: {
        uuid: valid.uuid,
        rfcEmisor: valid.rfcEmisor,
        rfcReceptor: valid.rfcReceptor,
        total: valid.total,
      },
      rejected: ["wrong_receiver", "wrong_total", "missing_uuid", "html", "malformed", "doctype", "placeholder"],
      storageGate: "validated before materialization",
    },
    null,
    2,
  ),
);
