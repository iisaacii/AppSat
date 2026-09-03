# Facturacion de tickets

Este modulo recibe una imagen de ticket y los datos fiscales del receptor,
localiza el portal del emisor, intenta generar el CFDI de forma automatica y
devuelve XML y PDF cuando estan disponibles.

Es un backend asincrono. La API no mantiene abierta una peticion mientras
navega en un portal: crea un job, lo coloca en la cola y el cliente consulta su
estado despues.

## Recorrido de un ticket

```text
POST /v2/billing/jobs
  -> Storage privado guarda la imagen
  -> Firestore guarda el job
  -> worker OCR extrae RFC, fecha, monto, folio y datos del portal
  -> discovery ordena QR, URL impresa, directorio y busqueda de respaldo
  -> router decide A, B3 o C
  -> XML/PDF se validan y se guardan en Storage
  -> GET /v2/billing/jobs/{jobId} entrega el resultado
```

La API V2 es autonoma: no pide una confirmacion humana del OCR entre etapas.
El OCR crea candidatos y variantes controladas. Si no puede obtener de forma
segura los datos indispensables, termina el job con `ocr_unresolved` en vez de
arriesgar una factura equivocada.

## Las tres capas

| Capa | Cuando se usa | Que hace |
| --- | --- | --- |
| A | Portal conocido con receta valida | Ejecuta una secuencia determinista de Playwright. Es la ruta rapida y de menor costo. |
| B3 | Portal nuevo, receta rota o pagina dinamica | Usa `browser-use` con Gemini `gemini-3.1-flash-lite` para interpretar la pagina, navegar y aprender. Un resultado valido puede compilarse y verificarse como receta A. |
| C | CAPTCHA, login obligatorio, bloqueo o dato que requiere una persona | Devuelve una accion tipada y un checkpoint. No vuelve a llamar IA automaticamente. |

La memoria de outcomes evita gastar B3 repetidamente: si un portal ya se sabe
que exige CAPTCHA o login, las siguientes corridas pasan directo a Capa C.

Un XML valido es suficiente como comprobante fiscal. El PDF mejora la
experiencia de lectura, pero su ausencia no invalida un XML ya descargado.

## Componentes

| Componente | Responsabilidad |
| --- | --- |
| API HTTP V2 | Autentica, valida el formulario, sube la imagen, crea jobs idempotentes y expone estado/eventos. |
| Firestore y Storage | Guardan jobs, eventos, imagenes, resultados y conocimiento compartido de portales. |
| Redis y BullMQ | Distribuyen trabajos entre procesos y aplican reintentos sin que dos workers procesen el mismo job. |
| Worker OCR | Google Vision como OCR base, normalizadores, QR, candidatos y Gemini Vision opcional para enriquecer. |
| Worker portal | Discovery, Capa A, B3, aprendizaje y descarga de CFDI. La concurrencia por portal se limita para no saturar sitios externos. |
| Worker Capa C | Prepara acciones manuales y checkpoints cuando el usuario debe terminar un portal. |
| `compiler_GPT/` | Convierte una sesion exitosa de B3 en candidato de receta A y ejecuta replay antes de promoverla. |

Stagehand y los experimentos B2 permanecen como herramientas de laboratorio;
la ruta automatica actual es A -> B3 -> C.

## Ejecutar localmente

Requisitos:

- Node.js 20 o posterior.
- Python 3 para B3/browser-use.
- Docker Desktop para Redis y los contenedores.
- Un proyecto Firebase, cuenta de servicio y bucket privados para un flujo
  real.
- Una clave de Gemini solo si se habilita B3 o Gemini Vision.

```powershell
npm ci
Copy-Item .env.example .env
npm run release:preflight
docker compose --profile workers up --build
```

El archivo `.env.example` describe las variables. Los valores de ejemplo usan
los nombres de AppSat, pero todo despliegue debe fijar su propio proyecto,
bucket, origenes CORS, Redis y secretos.

## API que consume una aplicacion externa

La ruta principal es:

```http
POST /v2/billing/jobs
Content-Type: multipart/form-data
Authorization: Bearer <credencial-configurada-en-el-despliegue>
Idempotency-Key: <uuid-unico-por-ticket>
```

El formulario lleva un archivo `ticket` y un campo JSON `taxProfile`. La
respuesta es `202 Accepted` con un `jobId`. Despues se consulta:

```http
GET /v2/billing/jobs/{jobId}
GET /v2/billing/jobs/{jobId}/events?limit=20
```

La guia completa, incluyendo ejemplos y estados, esta en
[docs/BILLING_API_V2_INTEGRATION_GUIDE.md](docs/BILLING_API_V2_INTEGRATION_GUIDE.md).

La autenticacion se configura por despliegue: Firebase ID token y, si el
operador decide habilitarlo, un token de servicio servidor-a-servidor. El
repositorio no trae ningun token activo.

## Estados importantes

| Estado | Significado para la integracion |
| --- | --- |
| `pending`, `ocr_processing`, `portal_processing` | El job sigue trabajando; consultar usando `pollAfterMs`. |
| `retry_scheduled` | Hay un error transitorio; el backend reintentara. |
| `completed` | Hay XML y/o PDF validado disponible en `result`. |
| `resolved` | No hace falta facturar otra vez, por ejemplo ticket ya facturado. |
| `needs_user_action` | Capa C necesita que una persona resuelva CAPTCHA, login o corrija un dato. |
| `failed` | El ticket no pudo resolverse de forma segura. |

## Validaciones utiles

```powershell
npm run release:preflight
npm run api:v2:validate
npm run ocr:autonomous:validate
npm run portal:outcome:validate
npm run b3:a-bridge:validate
npm run user-action:validate
```

Para una prueba real de staging existe `api:v2:submit-live`; requiere una
configuracion privada y banderas explicitas porque puede emitir un CFDI real.
No se ejecuta por accidente ni con los archivos de ejemplo.

## Limites actuales

- La automatizacion depende de sitios externos que pueden cambiar, bloquear
  navegadores o exigir CAPTCHA/login.
- Capa C ya entrega URL, checkpoint y datos de prellenado para una WebView,
  pero la ruta publica para volver a adjuntar XML/PDF descargado manualmente
  sigue siendo una integracion pendiente.
- Las recetas aprendidas y memoria de outcomes deben persistirse en Firestore o
  un almacenamiento privado compartido en produccion; los directorios locales
  estan excluidos de Git.

## Datos sensibles

No subas `.env`, cuentas de servicio, fotos, perfiles fiscales reales,
capturas, cookies, trazas de browser-use ni CFDI. Revisa tambien
[data/README.md](data/README.md).
