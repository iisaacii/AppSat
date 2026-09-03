# Capa C: Intervencion Del Usuario

## Objetivo

Capa C no intenta resolver el portal con otra IA. Es la salida controlada cuando A/B3 ya llegaron a una condicion que requiere al usuario o cuando el portal informa que el ticket ya esta resuelto.

El contrato para Flutter es `userAction`. El front puede mostrar estados, mensaje del portal, screenshot de evidencia, campos editables y un checkpoint para continuar manualmente.

## Estados

- `completed`: XML/PDF descargados y guardados.
- `resolved`: no hay que hacer mas automatizacion. Ejemplo principal: `ticket_already_invoiced`.
- `needs_user_action`: el usuario debe revisar datos o continuar manualmente.
- `failed`: error no recuperable del worker o infraestructura.

Dentro de `userAction.status` usamos:

- `resolved`: mensaje final para mostrar al usuario.
- `user_action_required`: requiere intervencion.

## Razones Principales

- `ticket_already_invoiced`: el portal dice que el ticket ya fue facturado. El job queda `resolved`. Si existe CFDI guardado en el job, `userAction.existingCfdi` apunta a XML/PDF.
- `ocr_review_required`: revision OCR obligatoria. En cada ticket nuevo el usuario confirma/corrige los datos detectados antes de correr A/B3.
- `ticket_data_rejected`: el portal rechazo folio, codigo de facturacion, monto, fecha, sucursal, serie o token.
- `ocr_review_required`: tambien incluye revision de campos criticos por giro. En gasolineras, `permisoCre` es critico y debe confirmarse si OCR lo omitio o lo detecto con baja confianza.
- `captcha_required`: el portal requiere CAPTCHA. Se guarda checkpoint para sesion interactiva corta.
- `login_required`: el portal requiere credenciales.
- `portal_blocked`: bot protection, portal inaccesible o bloqueo duro.
- `manual_portal_required`: no hay portal/receta suficiente para automatizar.

## Contrato `userAction`

```json
{
  "status": "user_action_required",
  "reason": "ticket_data_rejected",
  "title": "Datos rechazados por el portal",
  "message": "El portal rechazo los datos del ticket.",
  "expectedNextStep": "review_and_retry",
  "editableFields": [
    {
      "key": "codigoFacturacion",
      "label": "Codigo de facturacion",
      "value": "ABC123"
    }
  ],
  "portalMessage": "Codigo de facturacion invalido",
  "portalMessages": [],
  "evidence": {
    "screenshotUrl": null,
    "screenshotStoragePath": "portal-artifacts/...",
    "htmlStoragePath": "portal-artifacts/..."
  },
  "checkpoint": {
    "kind": "portal_checkpoint.v1",
    "portalUrl": "https://...",
    "currentUrl": "https://...",
    "templateId": "template-id",
    "portalFamily": "portal-family",
    "ticketData": {
      "folio": "12345",
      "codigoFacturacion": "ABC123"
    },
    "taxProfileId": "billing_lab_default"
  }
}
```

## UX Recomendado

Para A rapido:

1. Usuario toma foto.
2. Flutter muestra estados: OCR, buscando portal, facturando.
3. Si A descarga CFDI, mostrar PDF.

Para B3 lento:

1. El job sigue en backend.
2. Flutter no bloquea al usuario: muestra "Estamos generando tu factura" y permite salir.
3. Al completar, manda notificacion o refresca estado.

Para C:

1. Si `ticket_already_invoiced`, mostrar mensaje como resuelto. Si hay `existingCfdi`, mostrar boton de descargar.
2. Si `ocr_review_required`, mostrar campos OCR editables. Al guardar, actualizar el mismo job con `ocrReviewConfirmed=true`, `ocrReview.status="confirmed"`, `status="pending"`, limpiar `userAction` y enviar correcciones en `manualOverrides` si hubo cambios.
3. Si `ticket_data_rejected`, mostrar screenshot/mensaje y campos editables. Al guardar, crear reintento con `manualOverrides`.
4. Si `captcha_required`, `login_required` o `portal_blocked`, abrir un WebView desde `userAction.mobileHandoff.initialUrl`. En esa sesion ya no entra IA: el usuario termina lo faltante y descarga XML/PDF.

Para tickets de gasolina, si llega `ocr_review_required` con `editableFields` incluyendo `permisoCre`, mostrarlo como campo principal. Formato esperado:

```txt
PL/6927/EXP/ES/2015
```

El usuario puede corregirlo con `manualOverrides.permisoCre`; el worker tambien lo replica a `ocrCandidates.permisoCre` antes de reintentar A/B3.

Ejemplo minimo cuando el usuario confirma que el OCR esta correcto:

```json
{
  "status": "pending",
  "ocrReviewConfirmed": true,
  "ocrReview": { "status": "confirmed" },
  "userAction": null,
  "error": null,
  "lastError": null
}
```

Si corrigio algo, agregarlo a `manualOverrides`; por ejemplo `manualOverrides.folio`, `manualOverrides.monto` o `manualOverrides.permisoCre`.

## Handoff Flutter WebView

Para produccion elegimos WebView en Flutter, no navegador abierto en el servidor. Cuando Capa C llega a un bloqueo manual, el job trae:

```json
{
  "userAction": {
    "reason": "captcha_required",
    "expectedNextStep": "resume_interactive_checkpoint",
    "checkpoint": {
      "portalUrl": "https://...",
      "currentUrl": "https://...",
      "templateId": "template-id",
      "ticketData": {
        "folio": "12345",
        "monto": 99.5
      }
    },
    "mobileHandoff": {
      "kind": "flutter_webview_handoff.v1",
      "mode": "flutter_webview",
      "initialUrl": "https://...",
      "prefillData": {
        "ticket": {
          "folio": "12345",
          "monto": 99.5
        },
        "fiscal": {
          "rfc": "XAXX010101000",
          "legalName": "PERSONA CONTRIBUYENTE DEMO",
          "postalCode": "54040"
        }
      },
      "autofillHints": [],
      "completion": {
        "preferred": "download_cfdi_or_upload_files",
        "acceptedFiles": ["xml", "pdf"],
        "xmlIsSufficientForFiscalUse": true,
        "returnToApp": "easysat://billing/handoff-complete"
      }
    }
  }
}
```

Uso esperado en Flutter:

1. Abrir `mobileHandoff.initialUrl` en un WebView propio de Flutter, no en navegador externo.
2. Ejecutar `mobileHandoff.autofill.script` con `runJavaScript` en `onPageFinished` y tambien desde un boton "Intentar prellenar" si el usuario cambia de pantalla dentro del portal.
3. Mostrar una bandeja inferior con los datos de `prefillData` para que el usuario los copie/pegue si el portal bloquea la inyeccion.
4. `mobileHandoff.autofill.canRunInExternalBrowser=false`: en Chrome/Safari externo o en el lab web normal no se pueden llenar campos de otro dominio por seguridad del navegador.
4. El usuario resuelve CAPTCHA/login/bloqueo.
5. Si el portal descarga XML/PDF dentro del WebView, Flutter captura esos archivos y los sube al Storage del job.
6. Si el portal solo muestra botones de descarga, Flutter permite compartir/abrir el archivo y regresar a EasySat.

El XML es suficiente fiscalmente para declaracion; PDF es conveniente para vista humana, pero no debe bloquear el cierre si el XML ya fue capturado.

## Sesion Asistida Local De Lab

El runner local de C sigue existiendo solo para pruebas en la computadora del worker. No es el flujo de produccion movil.

```powershell
npm run user-action:resume -- --fixture=data/stagehand-fixtures/seven-ticket-2026-05-19-local.json --candidate=data/portal-template-candidates/SEM980701STA-www.e7-eleven.com.mx-b2_seven_ticket_local_lab-b3-compiled-gpt.candidate.json
```

Funcionamiento:

1. Abre navegador visible.
2. Rehidrata el portal con la receta A cuando existe.
3. Rellena los datos de ticket y perfil fiscal disponibles.
4. Hace un autofill final de campos fiscales visibles que la receta no haya cubierto.
5. Se detiene en `captcha_required`, `login_required`, `portal_blocked` o checkpoint manual.
6. El usuario resuelve el bloqueo humano.
7. Al presionar Enter en la terminal, el runner intenta continuar y captura descargas XML/PDF en `artifacts/user-action/interactive-runs`.

Para pruebas sin esperar input humano:

```powershell
npm run user-action:resume -- --fixture=data/stagehand-fixtures/seven-ticket-2026-05-19-local.json --candidate=data/portal-template-candidates/SEM980701STA-www.e7-eleven.com.mx-b2_seven_ticket_local_lab-b3-compiled-gpt.candidate.json --headless=true --wait-for-user=false --auto-submit-after-user=false
```

## Punto Pendiente

La busqueda cross-job de CFDI existente todavia no esta implementada. Por ahora `existingCfdi` se llena si el mismo job ya trae `resultXml*` o `resultPdf*`. El siguiente paso es consultar Firestore por huella de ticket: `uid + rfcEmisor + folio/codigoFacturacion + monto + fecha`.

## Validaciones

```powershell
npm run user-action:validate
npm run ticket:enrichment:validate
npm run user-action:preview
npm run user-action:orchestrator
npm run user-action:resume -- --fixture=data/stagehand-fixtures/seven-ticket-2026-05-19-local.json --candidate=data/portal-template-candidates/SEM980701STA-www.e7-eleven.com.mx-b2_seven_ticket_local_lab-b3-compiled-gpt.candidate.json --headless=true --wait-for-user=false --auto-submit-after-user=false
npm run contract:validate
```

`user-action:orchestrator` fuerza un ticket mock con emisor desconocido y valida que el orquestador devuelva `userAction.reason=manual_portal_required` con checkpoint en lugar de una salida ambigua.

`user-action:preview` genera un resumen visible de los escenarios principales en:

```txt
artifacts/user-action/capa-c-scenarios.latest.json
```

Escenarios incluidos:

- `ticket_already_invoiced_with_existing_cfdi`
- `ticket_data_rejected`
- `captcha_required`
- `portal_missing`

Nota de orquestacion: Capa C no debe devolver el job a IA. Si A o B3 detectan
`captcha_required`, `login_required` o `portal_blocked`, el outcome queda en
`portal-outcome-memory` y las siguientes corridas del mismo portal deben llegar
directo a C sin gastar B3.
