# Guia Rapida: Integrar EasySat Billing API V2

Esta guia es para cualquier equipo que quiera integrar su aplicacion con
EasySat. La app movil manda la foto y datos fiscales a su propio backend; ese
backend llama a EasySat.

No enviar el token de EasySat desde Flutter, una APK o JavaScript del
navegador.

## Que hace EasySat

EasySat recibe una foto de ticket y el perfil fiscal del receptor. Despues,
de forma asincrona, ejecuta:

```text
foto + perfil fiscal
  -> OCR y candidatos seguros
  -> busqueda del portal correcto
  -> Capa A: receta rapida, si ya se conoce el portal
  -> B3: navegacion adaptativa, si A no puede resolverlo
  -> XML y PDF cuando el portal los permite
  -> Capa C solamente si hace falta una persona
```

La solicitud inicial no espera a que termine la factura. Devuelve un `jobId`;
el backend integrador consulta ese `jobId` hasta tener el resultado.

## Datos necesarios

```text
API base: https://easysat-billing-stg-api-570722310741.us-central1.run.app
Credencial: debe ser configurada y entregada por EasySat antes de usar la API
```

La credencial debe guardarse como secreto en el servidor de la integracion, por
ejemplo en variables de entorno o su administrador de secretos. La integracion
no necesita usar Firebase de EasySat ni compartir su Firebase con EasySat. No
hay un token de servicio externo compartido activo en staging actualmente.

## Paso 1: Crear una solicitud de factura

Ruta:

```http
POST /v2/billing/jobs
```

La solicitud usa `multipart/form-data`, porque contiene una imagen y un JSON.

Headers obligatorios:

```http
Authorization: Bearer TOKEN_DE_EASYSAT
Idempotency-Key: UUID_UNICO_POR_TICKET
```

Campos del formulario:

| Campo | Tipo | Requerido | Que contiene |
| --- | --- | --- | --- |
| `ticket` | archivo | Si | JPG, PNG, WebP o AVIF; maximo 10 MiB. |
| `taxProfile` | texto JSON | Si | Perfil fiscal completo del usuario. |
| `rfcReceptor` | texto | No | RFC del receptor; si se envia debe coincidir con `taxProfile.rfc`. |

`taxProfile` necesita estos campos:

```json
{
  "rfc": "XAXX010101000",
  "legalName": "PERSONA CONTRIBUYENTE DEMO",
  "email": "correo@ejemplo.com",
  "fiscalRegime": "605",
  "cfdiUse": "S01",
  "postalCode": "54000",
  "street": "CALLE EJEMPLO",
  "exteriorNumber": "123",
  "interiorNumber": "",
  "neighborhood": "COLONIA EJEMPLO",
  "municipality": "TLALNEPANTLA DE BAZ",
  "state": "ESTADO DE MEXICO",
  "country": "MEXICO"
}
```

`interiorNumber`, `email` y `country` son opcionales, aunque el correo es
recomendable porque muchos portales lo piden. Los demas campos son necesarios.

Ejemplo en PowerShell:

```powershell
$baseUrl = "https://easysat-billing-stg-api-570722310741.us-central1.run.app"
$token = $env:EASYSAT_BILLING_TOKEN
$requestId = [guid]::NewGuid().ToString()

$taxProfile = @{
  rfc = "XAXX010101000"
  legalName = "PERSONA CONTRIBUYENTE DEMO"
  email = "correo@ejemplo.com"
  fiscalRegime = "605"
  cfdiUse = "S01"
  postalCode = "54000"
  street = "CALLE EJEMPLO"
  exteriorNumber = "123"
  neighborhood = "COLONIA EJEMPLO"
  municipality = "TLALNEPANTLA DE BAZ"
  state = "ESTADO DE MEXICO"
  country = "MEXICO"
} | ConvertTo-Json -Compress

curl.exe -X POST "$baseUrl/v2/billing/jobs" `
  -H "Authorization: Bearer $token" `
  -H "Idempotency-Key: $requestId" `
  -F "ticket=@C:\ruta\ticket.jpg;type=image/jpeg" `
  -F "taxProfile=$taxProfile"
```

Respuesta esperada: `202 Accepted`.

```json
{
  "data": {
    "id": "job_abc123",
    "status": "pending",
    "processingMode": "autonomous",
    "workflowStage": "ocr",
    "statusMessage": "Ticket recibido",
    "isTerminal": false,
    "needsUserAction": false,
    "pollAfterMs": 5000
  },
  "meta": {
    "reused": false,
    "apiVersion": "billing-http.v2"
  }
}
```

El backend integrador debe guardar `data.id`. Ese valor es el `jobId` de la
factura.

## Paso 2: Consultar el avance

Ruta:

```http
GET /v2/billing/jobs/{jobId}
```

Ejemplo:

```powershell
$jobId = "job_abc123"

curl.exe -H "Authorization: Bearer $token" `
  "$baseUrl/v2/billing/jobs/$jobId"
```

El backend integrador debe volver a consultar usando `data.pollAfterMs` en
milisegundos. Por ejemplo, `5000` significa consultar aproximadamente cinco
segundos despues. Si vale `0`, el job termino o espera una accion humana.

Para mostrar una linea de tiempo tecnica, opcionalmente puede consultar:

```http
GET /v2/billing/jobs/{jobId}/events?limit=20
```

## Paso 3: Interpretar el resultado

| Estado | Que debe hacer la integracion |
| --- | --- |
| `pending`, `ocr_processing`, `portal_processing` | Seguir consultando con `pollAfterMs`. |
| `retry_scheduled` | Esperar y seguir consultando. EasySat reintentara automaticamente. |
| `completed` | Entregar `data.result.xmlUrl` y/o `data.result.pdfUrl` al usuario. |
| `resolved` | Mostrar el mensaje. Usualmente el ticket ya estaba facturado. |
| `needs_user_action` | Revisar `data.userAction` y mostrar la ayuda indicada. |
| `failed` | Mostrar `data.error.message` o `data.statusMessage`; no crear otro job automaticamente. |

Un XML valido es suficiente para una factura fiscal. El PDF es adicional para
visualizacion humana; algunos portales no lo entregan.

Ejemplo de resultado terminado:

```json
{
  "data": {
    "id": "job_abc123",
    "status": "completed",
    "isTerminal": true,
    "needsUserAction": false,
    "pollAfterMs": 0,
    "result": {
      "xmlUrl": "https://...",
      "pdfUrl": "https://...",
      "validation": { "valid": true },
      "warning": null
    }
  }
}
```

## Capa C: cuando una persona debe intervenir

La ruta automatica cubre OCR, busqueda de portal, A y B3. Capa C aparece solo
si hay CAPTCHA, login, proteccion del portal o una accion que una persona debe
realizar.

La respuesta trae `data.userAction`, con el motivo, mensaje y, cuando existe,
un `mobileHandoff` para abrir el portal en un WebView de Flutter.

Si la aplicacion necesita preparar ese handoff, envia este comando al presionar
el boton `Continuar en portal`:

```http
POST /v2/billing/jobs/{jobId}/commands
Authorization: Bearer TOKEN_DE_EASYSAT
Idempotency-Key: UUID_NUEVO
Content-Type: application/json
```

```json
{
  "type": "request_capa_c_resume",
  "payload": {}
}
```

Luego consulta el job de nuevo y abre:

```text
data.userAction.mobileHandoff.initialUrl
```

en el WebView de la app. El usuario resuelve el CAPTCHA o login directamente
en el portal.

Importante: este comando prepara el portal asistido; no significa que la
factura ya fue descargada. La API V2 actual todavia no expone una ruta publica
para que el backend integrador suba y asocie al job el XML/PDF que el usuario
descargue manualmente dentro de su propio WebView. Esa integracion debe cerrarse
antes de considerar Capa C manual como flujo final de produccion.

## Idempotencia: evitar facturas duplicadas

Para cada ticket nuevo, el backend integrador genera un UUID nuevo en
`Idempotency-Key`.

- Si hay timeout o pierde internet, repite exactamente la misma solicitud con
  la misma clave: EasySat devuelve el mismo job.
- Para otro ticket, usa una clave nueva.
- No reutilizar una clave con otra foto o perfil fiscal: la API responde `409`.

## Errores frecuentes

| HTTP | Significado | Que revisar |
| --- | --- | --- |
| `400` | Solicitud invalida | JSON de `taxProfile`, nombre de campos o `Idempotency-Key`. |
| `401` | Token ausente o invalido | Header `Authorization` y secreto del servidor. |
| `413` | Imagen muy grande | Maximo 10 MiB. |
| `415` | Tipo de imagen incorrecto | Usar JPG, PNG, WebP o AVIF reales. |
| `422` | Perfil fiscal incompleto/invalido | RFC, regimen, uso CFDI, CP y domicilio. |
| `429` | Demasiadas solicitudes | Esperar el tiempo indicado antes de reintentar. |

## Resumen operativo

```text
Aplicacion cliente
  -> backend integrador: foto + perfil fiscal
  -> EasySat POST /v2/billing/jobs
  <- jobId
  -> EasySat GET /v2/billing/jobs/{jobId} hasta terminar
  <- XML/PDF, estado resuelto, error o instruccion Capa C
  -> backend integrador devuelve el resultado a la aplicacion
```

Usar solo rutas `/v2/billing/...` para una integracion nueva. Las rutas `/v1`
pertenecen al Billing Lab antiguo y no son el contrato de una integracion nueva.
