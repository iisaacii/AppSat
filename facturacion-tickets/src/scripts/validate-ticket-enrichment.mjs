import assert from "node:assert/strict";
import {
  enrichTicketExtraction,
  extractPermisoCreCandidates,
  normalizePermisoCre,
} from "../ocr/ticket-enrichment.service.mjs";
import { extractFields } from "../ocr/google-vision-ocr.service.mjs";
import { buildOcrFieldReview } from "../orchestrator/autopilot-policy.mjs";
import { buildUserActionRequiredResult } from "../orchestrator/user-action-policy.mjs";

assert.equal(normalizePermisoCre("PL/6927/EXP/ES/2015"), "PL/6927/EXP/ES/2015");
assert.equal(normalizePermisoCre("P1 06927 EKP E5 2015"), "PL/6927/EXP/ES/2015");

const direct = extractPermisoCreCandidates("G500 PERMISO CRE: PL/6927/EXP/ES/2015 TOTAL 200.00", {
  fuelProfile: { isFuel: true },
});
assert.equal(direct.value, "PL/6927/EXP/ES/2015");
assert.equal(direct.needsReview, false);

const inferred = enrichTicketExtraction({
  ocrText:
    "G500\nESTACION P06927\nPermiso CRE borroso EXP/ES/2015\nG SUPER 8.610 LTR\nTOTAL 200.00",
  ocrCandidates: {
    emisorNombre: "G500",
    estacionCodigo: "P06927",
  },
});

assert.equal(inferred.businessDomain, "fuel");
assert.equal(inferred.permisoCre, "PL/6927/EXP/ES/2015");
assert.equal(inferred.ticketEnrichment.permisoCre.needsReview, true);

const review = buildOcrFieldReview({ extracted: inferred, template: null });
assert.equal(review.requiresUserAction, true);
assert.ok(review.missingTicketFields.some((field) => field.field === "permisoCre"));

const userAction = buildUserActionRequiredResult({
  reason: "ocr_review_required",
  statusMessage: review.statusMessage,
  extracted: inferred,
  editableFields: review.missingTicketFields,
});

assert.ok(userAction.userAction.editableFields.some((field) => field.key === "permisoCre"));

const clear = enrichTicketExtraction({
  ocrText: "G500\nPermiso CRE PL/6927/EXP/ES/2015\nFOLIO 12020277\nTOTAL 200.00",
  folio: "12020277",
  fecha: "2026-05-24",
  monto: 200,
  ocrCandidates: {
    emisorNombre: "G500",
  },
  ocrConfidence: {
    folio: 0.9,
    fecha: 0.9,
    monto: 0.9,
  },
});

assert.equal(clear.permisoCre, "PL/6927/EXP/ES/2015");
assert.equal(clear.ticketEnrichment.permisoCre.needsReview, false);

const hmDiscountTicket = extractFields(`H&M
Subtotal de recibo:
647.00
Miembro $
-50.00
Voucher de miembro
10393005020501159156
Total
Artículos vendidos
Descuento
Tarjeta de Débito
Núm. Tarj.
Núm. Seguimiento
Autorización
IVA%
16.00
597.00 MXN
3
-50.00
MXN 597.00
IVA
NETO Total
82.34
514.66
597.00
`);

assert.equal(hmDiscountTicket.monto, 597);

const tierraGaratColumnTicket = extractFields(`TIERRA GARAT SUCURSAL ZONA AZUL
Cto. Economistas F5 Fracc, Ciudad Satelite
Naucalpan de Juarez C.P. 53100, Estado de Mexico
Mesero: ANA SOFIA
Mesa 101/1
Clientes: 1
CUERNITO DE PAVO
CAC NEGRA FLOR GL
CREMA BATIDA
6x1 TG
Sub-total
Total
VISA DEBIT
Pendiente de Pago
17/05/2026
8:53 PM
100.00
79.00
10.00
-89.00
100.00
100.00
100.00
0.00
I.V.A. Incluido
`);

assert.equal(tierraGaratColumnTicket.monto, 100);

const sevenTicket = extractFields(`7 ELEVEN MEXICO SA DE CV -
RFC:SEM980701STA
05/19/2026 2:30:19 PM 1002 817281 3 22
TOTAL
28.00
TARJ. BANCARIA
28.00
Ingresa a la pagina para generar tu factura a 7-Eleven.com.mx
10021905202632000081728100022008834
No. Autorizacion 001506
NO. AFILIACION 6690416
`);

assert.equal(sevenTicket.rfcEmisor, "SEM980701STA");
assert.equal(sevenTicket.fecha, "2026-05-19");
assert.equal(sevenTicket.folio, "817281");
assert.equal(sevenTicket.ocrCandidates.ticketId, "10021905202632000081728100022008834");
assert.equal(sevenTicket.ocrCandidates.codigoFacturacion, "10021905202632000081728100022008834");
assert.equal(sevenTicket.ocrCandidates.formaPago, "04");
assert.equal(sevenTicket.monto, 28);

console.log("ticket enrichment validation passed");
