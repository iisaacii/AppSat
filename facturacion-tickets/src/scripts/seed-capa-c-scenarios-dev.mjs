import { FieldValue } from "firebase-admin/firestore";
import { getFirebaseDb, getFirebaseStorageBucket } from "../config/firebase.mjs";
import { getFirestoreRoot } from "../config/env.mjs";
import {
  buildResolvedAlreadyInvoicedResult,
  buildUserActionRequiredResult,
} from "../orchestrator/user-action-policy.mjs";

const uid = getArg("uid") ?? "demo_user";
const clear = getArg("clear") !== "false";
const now = Date.now();

const db = getFirebaseDb();
const bucket = getFirebaseStorageBucket();
const { collection, document } = getFirestoreRoot();
const jobsRef = db.collection(collection).doc(document).collection("users").doc(uid).collection("facturaJobs");

if (clear) {
  const previous = await jobsRef.where("source", "==", "capa_c_demo").get();
  const batch = db.batch();
  for (const doc of previous.docs) {
    batch.delete(doc.ref);
  }
  await batch.commit();
}

const cfdiPaths = await seedCfdiArtifacts(uid);
const scenarios = buildScenarios({ uid, cfdiPaths });

const batch = db.batch();
for (const [index, scenario] of scenarios.entries()) {
  const jobRef = jobsRef.doc(scenario.id);
  const eventRef = jobRef.collection("events").doc();
  batch.set(jobRef, {
    id: scenario.id,
    uid,
    source: "capa_c_demo",
    contractVersion: "factura-job.v1",
    ticketFileUrl: "mock://capa-c-demo-ticket.jpg",
    rfcReceptor: "XAXX010101000",
    taxProfileId: "billing_lab_default",
    taxProfile: demoTaxProfile(),
    portalFinalSubmitApproved: true,
    rfcEmisor: scenario.extracted.rfcEmisor,
    folio: scenario.extracted.folio,
    fecha: scenario.extracted.fecha,
    monto: scenario.extracted.monto,
    codigoFacturacion: scenario.extracted.codigoFacturacion ?? null,
    permisoCre: scenario.extracted.permisoCre ?? null,
    ocrEngine: "simulado_capa_c",
    ocrConfidence: {
      rfcEmisor: 0.99,
      folio: 0.98,
      fecha: 0.98,
      monto: 0.98,
    },
    ocrCandidates: {
      ticketId: scenario.extracted.ticketId ?? scenario.extracted.folio,
      codigoFacturacion: scenario.extracted.codigoFacturacion ?? null,
      sucursal: scenario.extracted.sucursal ?? null,
    },
    extractedData: scenario.extracted,
    portalName: scenario.template?.name ?? scenario.portalName ?? null,
    portalUrl: scenario.template?.portalUrl ?? scenario.portalUrl ?? null,
    portalCandidateUrl: scenario.template?.portalUrl ?? scenario.portalUrl ?? null,
    portalRunResult: scenario.portalRunResult ?? null,
    portalPreflightResult: null,
    ...scenario.result,
    attemptCount: 1,
    claimedBy: null,
    leaseExpiresAt: null,
    retryAt: null,
    createdAt: new Date(now + index * 1000),
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(eventRef, {
    id: eventRef.id,
    type: scenario.result.status,
    status: scenario.result.status,
    message: scenario.result.statusMessage,
    actor: "codex",
    workerId: null,
    attemptCount: 1,
    metadata: {
      scenario: scenario.id,
      reason: scenario.result.reason,
      expectedNextStep: scenario.result.userAction?.expectedNextStep ?? null,
    },
    createdAt: FieldValue.serverTimestamp(),
  });
}

await batch.commit();

console.log(
  JSON.stringify(
    {
      ok: true,
      uid,
      count: scenarios.length,
      jobs: scenarios.map((scenario) => ({
        id: scenario.id,
        status: scenario.result.status,
        reason: scenario.result.reason,
        title: scenario.result.userAction?.title ?? null,
      })),
    },
    null,
    2,
  ),
);

function buildScenarios({ uid, cfdiPaths }) {
  const baseJob = {
    id: "capa_c_demo_base",
    uid,
    taxProfileId: "billing_lab_default",
    portalCandidateUrl: "https://facturacion.demo.test",
    portalFinalSubmitApproved: true,
  };
  const template = {
    id: "demo-template",
    name: "Portal demo C",
    portalFamily: "demo",
    portalUrl: "https://facturacion.demo.test",
  };
  const captchaTemplate = {
    id: "capa-c-captcha-demo",
    name: "Capa C CAPTCHA Demo",
    portalFamily: "demo",
    portalUrl: "https://facturacion.demo.test/captcha",
  };

  const baseExtracted = {
    rfcEmisor: "AAA010101AAA",
    folio: "12345",
    ticketId: "12345",
    fecha: "2026-05-21",
    monto: 99.5,
    codigoFacturacion: "ABC123",
    sucursal: "001",
    serie: "A",
    token: "TOKEN123",
  };

  return [
    {
      id: "capa_c_demo_01_revisar_ocr",
      extracted: {
        ...baseExtracted,
        rfcEmisor: "OCS120223SN2",
        folio: "20242",
        ticketId: "20242",
        fecha: "2026-05-17",
        monto: 100,
      },
      template,
      portalRunResult: null,
      result: buildUserActionRequiredResult({
        reason: "ocr_review_required",
        statusMessage: "Revisa y confirma los datos detectados del ticket antes de facturar.",
        job: baseJob,
        extracted: {
          ...baseExtracted,
          rfcEmisor: "OCS120223SN2",
          folio: "20242",
          fecha: "2026-05-17",
          monto: 100,
        },
        template,
        editableFields: [
          { key: "rfcEmisor", label: "RFC emisor", value: "OCS120223SN2" },
          { key: "folio", label: "Folio/ticket", value: "20242" },
          { key: "fecha", label: "Fecha", value: "2026-05-17" },
          { key: "monto", label: "Monto", value: 100 },
        ],
      }),
    },
    {
      id: "capa_c_demo_02_datos_rechazados",
      extracted: baseExtracted,
      template,
      portalRunResult: {
        reason: "ticket_not_found",
        currentUrl: "https://facturacion.demo.test/validar-ticket",
        portalMessage: "Codigo de facturacion invalido",
        missingFields: ["codigoFacturacion"],
        artifacts: {
          screenshotUrl: "https://placehold.co/1000x620/111827/fbbf24.png?text=Portal+rechazo+datos+del+ticket",
          htmlUrl: "https://example.com/demo-ticket-rechazado.html",
        },
      },
      result: buildUserActionRequiredResult({
        reason: "ticket_not_found",
        statusMessage: "El portal no encontro el ticket con esos datos.",
        job: baseJob,
        extracted: baseExtracted,
        template,
        portalRunResult: {
          reason: "ticket_not_found",
          currentUrl: "https://facturacion.demo.test/validar-ticket",
          portalMessage: "Codigo de facturacion invalido",
          missingFields: ["codigoFacturacion"],
          artifacts: {
            screenshotUrl: "https://placehold.co/1000x620/111827/fbbf24.png?text=Portal+rechazo+datos+del+ticket",
            htmlUrl: "https://example.com/demo-ticket-rechazado.html",
          },
        },
      }),
    },
    {
      id: "capa_c_demo_03_captcha",
      extracted: baseExtracted,
      template: captchaTemplate,
      portalRunResult: {
        reason: "captcha_detected",
        currentUrl: "https://facturacion.demo.test/captcha",
        artifacts: {
          screenshotUrl: "https://placehold.co/1000x620/111827/f87171.png?text=CAPTCHA+requerido",
        },
      },
      result: buildUserActionRequiredResult({
        reason: "captcha_detected",
        statusMessage: "El portal requiere resolver un CAPTCHA.",
        job: baseJob,
        extracted: baseExtracted,
        template: captchaTemplate,
        portalRunResult: {
          reason: "captcha_detected",
          currentUrl: "https://facturacion.demo.test/captcha",
          artifacts: {
            screenshotUrl: "https://placehold.co/1000x620/111827/f87171.png?text=CAPTCHA+requerido",
          },
        },
      }),
    },
    {
      id: "capa_c_demo_04_login",
      extracted: baseExtracted,
      template,
      portalRunResult: {
        reason: "login_required",
        currentUrl: "https://facturacion.demo.test/login",
        portalMessage: "El portal solicita cuenta de acceso.",
        artifacts: {
          screenshotUrl: "https://placehold.co/1000x620/111827/93c5fd.png?text=Login+o+cuenta+requerida",
        },
      },
      result: buildUserActionRequiredResult({
        reason: "login_required",
        statusMessage: "El portal requiere iniciar sesion o crear una cuenta de acceso.",
        job: baseJob,
        extracted: baseExtracted,
        template,
        portalRunResult: {
          reason: "login_required",
          currentUrl: "https://facturacion.demo.test/login",
          portalMessage: "El portal solicita cuenta de acceso.",
          artifacts: {
            screenshotUrl: "https://placehold.co/1000x620/111827/93c5fd.png?text=Login+o+cuenta+requerida",
          },
        },
      }),
    },
    {
      id: "capa_c_demo_05_portal_bloqueado",
      extracted: baseExtracted,
      template,
      portalRunResult: {
        reason: "cloudflare_blocked",
        currentUrl: "https://facturacion.demo.test/bloqueado",
        portalMessage: "El portal bloqueo la automatizacion.",
        artifacts: {
          screenshotUrl: "https://placehold.co/1000x620/111827/c084fc.png?text=Portal+bloqueado",
        },
      },
      result: buildUserActionRequiredResult({
        reason: "cloudflare_blocked",
        statusMessage: "El portal bloqueo la automatizacion.",
        job: baseJob,
        extracted: baseExtracted,
        template,
        portalRunResult: {
          reason: "cloudflare_blocked",
          currentUrl: "https://facturacion.demo.test/bloqueado",
          portalMessage: "El portal bloqueo la automatizacion.",
          artifacts: {
            screenshotUrl: "https://placehold.co/1000x620/111827/c084fc.png?text=Portal+bloqueado",
          },
        },
      }),
    },
    {
      id: "capa_c_demo_06_portal_manual",
      extracted: {
        ...baseExtracted,
        rfcEmisor: "XXX010101XXX",
      },
      template: null,
      portalName: "Portal no identificado",
      portalUrl: null,
      portalRunResult: null,
      result: buildUserActionRequiredResult({
        reason: "portal_template_missing",
        statusMessage: "No hay portal automatizado para este emisor.",
        job: {
          ...baseJob,
          portalCandidateUrl: null,
        },
        extracted: {
          ...baseExtracted,
          rfcEmisor: "XXX010101XXX",
        },
        template: null,
        failure: {
          type: "portal_missing",
          reason: "portal_template_missing",
        },
      }),
    },
    {
      id: "capa_c_demo_07_ya_facturado",
      extracted: baseExtracted,
      template,
      portalRunResult: {
        reason: "ticket_already_invoiced",
        currentUrl: "https://facturacion.demo.test/reimpresion",
        portalMessage: "Comprobante generado previamente.",
        artifacts: {
          screenshotUrl: "https://placehold.co/1000x620/111827/34d399.png?text=Ticket+ya+facturado",
        },
      },
      result: buildResolvedAlreadyInvoicedResult({
        job: {
          ...baseJob,
          resultXmlStoragePath: cfdiPaths.xml,
          resultPdfStoragePath: cfdiPaths.pdf,
        },
        extracted: baseExtracted,
        template,
        portalRunResult: {
          reason: "ticket_already_invoiced",
          currentUrl: "https://facturacion.demo.test/reimpresion",
          portalMessage: "Comprobante generado previamente.",
          artifacts: {
            screenshotUrl: "https://placehold.co/1000x620/111827/34d399.png?text=Ticket+ya+facturado",
          },
        },
      }),
    },
  ];
}

async function seedCfdiArtifacts(uid) {
  const xmlPath = `billing-lab/cfdis/${uid}/capa_c_demo_07_ya_facturado/cfdi.xml`;
  const pdfPath = `billing-lab/cfdis/${uid}/capa_c_demo_07_ya_facturado/cfdi.pdf`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Total="99.50">
  <cfdi:Emisor Rfc="AAA010101AAA" Nombre="PORTAL DEMO C"/>
  <cfdi:Receptor Rfc="XAXX010101000" Nombre="PERSONA CONTRIBUYENTE DEMO"/>
</cfdi:Comprobante>
`;
  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 79 >>
stream
BT /F1 18 Tf 72 720 Td (CFDI demo Capa C - ticket ya facturado) Tj ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000241 00000 n
0000000370 00000 n
trailer
<< /Size 6 /Root 1 0 R >>
startxref
440
%%EOF
`;

  await bucket.file(xmlPath).save(Buffer.from(xml, "utf8"), {
    metadata: { contentType: "application/xml" },
    resumable: false,
  });
  await bucket.file(pdfPath).save(Buffer.from(pdf, "utf8"), {
    metadata: { contentType: "application/pdf" },
    resumable: false,
  });

  return { xml: xmlPath, pdf: pdfPath };
}

function demoTaxProfile() {
  return {
    rfc: "XAXX010101000",
    legalName: "PERSONA CONTRIBUYENTE DEMO",
    email: "pruebas@appsat.dev",
    fiscalRegime: "605 - Sueldos y Salarios e Ingresos Asimilados a Salarios",
    fiscalRegimes: ["605 - Sueldos y Salarios e Ingresos Asimilados a Salarios"],
    cfdiUse: "S01 - Sin efectos fiscales",
    postalCode: "54040",
    street: "CAOBA",
    exteriorNumber: "23",
    interiorNumber: "",
    neighborhood: "VALLE DE LOS PINOS",
    municipality: "TLALNEPANTLA DE BAZ",
    state: "MEXICO",
    country: "MEXICO",
  };
}

function getArg(name) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}
