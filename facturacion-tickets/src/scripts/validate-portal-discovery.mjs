import {
  applyPortalDiscoveryToExtraction,
  discoverPortalFromTicket,
  extractPortalTicketFields,
  extractPortalUrlCandidatesFromText,
} from "../portal-discovery/portal-discovery.service.mjs";

const sampleText = `
PINTURAS MAR S.A DE CV
RFC: PMA1805167L1
15 mayo, 2026 9:51:14 AM
No.Ticket: 37240 No.Venta:37240
Total: 99.50
DATOS PARA FACTURAR:
Link: pinturerias.com.mx
Sucursal 1806
Folio Ticket 37240
Serie TRPALA
Token 32580782
`;

const fields = extractPortalTicketFields(sampleText);
const urls = extractPortalUrlCandidatesFromText(sampleText);
const discovery = await discoverPortalFromTicket({
  job: { id: "portal_discovery_probe", ticketFileUrl: "mock://ticket-pintura.jpg" },
  extracted: {
    rfcEmisor: "PMA1805167L1",
    folio: "37240",
    fecha: "2026-05-15",
    monto: 99.5,
    ocrText: sampleText,
    ocrCandidates: {},
  },
  decodeQr: false,
  probeUrls: false,
});
const qrPriorityDiscovery = await discoverPortalFromTicket({
  job: { id: "portal_discovery_qr_priority_probe", ticketFileUrl: "mock://ticket-with-qr.jpg" },
  extracted: {
    rfcEmisor: "AAA010101AAA",
    ocrText: "DATOS PARA FACTURAR Link: texto-facturacion.com.mx",
    ocrCandidates: {
      qrValues: ["https://qr-facturacion.com.mx/portal"],
    },
  },
  decodeQr: false,
  probeUrls: false,
});
const extracted = applyPortalDiscoveryToExtraction(
  {
    rfcEmisor: "PMA1805167L1",
    fecha: "2026-05-15",
    monto: 99.5,
    ocrCandidates: {},
  },
  discovery,
);
const checks = [
  fields.sucursal === "1806",
  fields.folioTicket === "37240",
  fields.serie === "TRPALA",
  fields.token === "32580782",
  urls[0]?.url === "https://pinturerias.com.mx",
  discovery.bestCandidate?.url === "https://pinturerias.com.mx",
  qrPriorityDiscovery.bestCandidate?.url === "https://qr-facturacion.com.mx/portal",
  qrPriorityDiscovery.bestCandidate?.source === "qr",
  qrPriorityDiscovery.portalCandidates[1]?.url === "https://texto-facturacion.com.mx",
  extracted.ocrCandidates.token === "32580782",
  extracted.portalUrl === "https://pinturerias.com.mx",
];

console.log(
  JSON.stringify(
    {
      ok: checks.every(Boolean),
      fields,
      urls,
      discovery: {
        status: discovery.status,
        bestCandidate: discovery.bestCandidate,
        portalCandidates: discovery.portalCandidates,
      },
      qrPriorityDiscovery: {
        bestCandidate: qrPriorityDiscovery.bestCandidate,
        portalCandidates: qrPriorityDiscovery.portalCandidates,
      },
      extracted: {
        folio: extracted.folio,
        portalUrl: extracted.portalUrl,
        ocrCandidates: extracted.ocrCandidates,
      },
    },
    null,
    2,
  ),
);

if (!checks.every(Boolean)) {
  process.exitCode = 1;
}
