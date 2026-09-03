import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildFiscalComplianceContext } from "../fiscal/fiscal-compliance.service.mjs";

export async function buildPintureriasStagehandFixture({
  portalUrl = "https://facturacionpintu.com.mx",
  ticketImagePath = join(process.env.USERPROFILE ?? ".", "Downloads", "ticket_pintura.jpg"),
  profilePath = "data/tax-profiles/sample.json",
  approveFinalSubmit = false,
} = {}) {
  const taxProfile = JSON.parse(await readFile(resolve(profilePath), "utf8"));
  const fiscalCompliance = buildFiscalComplianceContext(taxProfile);
  const extracted = {
    rfcEmisor: "PMA1805167L1",
    folio: "37240",
    fecha: "2026-05-15",
    monto: 99.5,
    ocrEngine: "mock",
    ocrText: PINTURERIAS_TICKET_TEXT,
    ocrTextPreview: PINTURERIAS_TICKET_TEXT.slice(0, 1200),
    ocrCandidates: {
      rfc: ["PMA1805167L1"],
      folioTicket: "37240",
      noTicket: "37240",
      noVenta: "37240",
      ticketId: "37240",
      sucursal: "1806",
      serie: "TRPALA",
      token: "32580782",
      fecha: "2026-05-15",
      monto: 99.5,
    },
  };
  const job = {
    id: "stagehand_pinturerias_lab",
    uid: "billing_lab_local",
    ticketFileUrl: ticketImagePath,
    aiPortalUrl: portalUrl,
    portalCandidateUrl: portalUrl,
    portalCandidates: [
      {
        url: portalUrl,
        source: "stagehand_lab_fixture",
        confidence: 1,
      },
    ],
    rfcReceptor: taxProfile.rfc,
    taxProfile,
    fiscalCompliance,
    portalFinalSubmitApproved: approveFinalSubmit,
    manualOverrides: {
      ...extracted,
    },
  };

  return {
    job,
    extracted,
    taxProfile,
    fiscalCompliance,
    portalUrl,
  };
}

export const PINTURERIAS_TICKET_TEXT = `
PINTURAS MAR S.A DE CV
SUPER AVENIDA LOMAS VERDES 464
PISO 3 COL. LOMAS VERDES
NAUCALPAN DE JUAREZ
ESTADO DE MEXICO, C.P. 53120
RFC: PMA1805167L1
Regimen General de Ley Personas Morales
15 mayo, 2026 9:51:14 AM
No.Ticket: 37240 No.Venta:37240
SUCURSAL 1806 SOR JUANA
AV. MAGDALENA MZ 5 LT 34
CENTRO TLALNEPANTLA 54000
TLALNEPANTLA DE BAZ EDO. DE MEX.
1 PZ AEROCOMEX NEGRO BRILLANTE
Total: 99.50
DATOS PARA FACTURAR:
Link: pinturerias.com.mx
Sucursal 1806
Folio Ticket 37240
Serie TRPALA
Token 32580782
Vigente para facturar en linea hasta las 8:00 pm del ultimo dia del mes en que realizo su compra.
`;
