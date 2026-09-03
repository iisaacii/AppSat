# Despliegue de facturacion

El servicio se despliega como varios procesos pequenos. Separarlos evita que
una navegacion lenta de B3 bloquee la API o el OCR de otros usuarios.

## Servicios

| Servicio | Imagen | Responsabilidad |
| --- | --- | --- |
| API | `Dockerfile` | Recibe solicitudes V2, sube tickets, crea jobs y expone estado. |
| OCR worker | `Dockerfile.worker-ocr` | OCR, QR, candidatos y handoff al portal. |
| Portal worker | `Dockerfile.worker-browser` | Capa A, B3, receta aprendida, CFDI y validacion. |
| Capa C worker | `Dockerfile.worker-browser` | Prepara reanudaciones y handoff manual. |
| Queue monitor | `Dockerfile` | Vigila colas, trabajos atorados y fallos recientes. |
| Redis | `redis:7.4-alpine` local | Cola BullMQ y limite distribuido por portal. |

## Desarrollo con Docker

Desde `facturacion-tickets`:

```powershell
Copy-Item .env.example .env
docker compose --profile workers up --build
```

Antes de iniciar, configura fuera de Git:

- `FIREBASE_PROJECT_ID`, `FIREBASE_STORAGE_BUCKET` y cuenta de servicio.
- `GEMINI_API_KEY` si se habilitan B3 o Gemini Vision.
- `REDIS_URL` si Redis no corre dentro de Compose.
- `BILLING_API_ALLOWED_ORIGINS` y la credencial de API elegida.

Los valores de ejemplo son solo nombres de AppSat. No son credenciales ni un
despliegue compartido.

## Cloud Run

Los archivos `cloud-run/staging.config.example.json` e
`cloud-run/staging.infrastructure.json` describen el despliegue recomendado.
El render genera un servicio API y workers para OCR, portal, Capa C y monitor.

Para una instalacion nueva:

1. Crear proyecto, bucket privado, Firestore, red y Redis administrado.
2. Crear una cuenta de servicio de runtime con permisos minimos para Firestore,
   Storage, Secret Manager y logs.
3. Guardar la clave de Gemini y, si se usa, el hash de token de servicio en
   Secret Manager.
4. Construir imagenes inmutables y referenciarlas por digest.
5. Renderizar y validar los manifiestos.
6. Desplegar API y workers; confirmar salud de cola antes de abrir trafico.

La API puede escalar horizontalmente. El worker portal debe empezar con baja
concurrencia porque cada sitio externo tiene limites distintos; el rate limiter
distribuido evita que varias instancias procesen el mismo portal al mismo
tiempo.

## Verificacion antes de publicar

```powershell
npm run release:preflight
npm run deployment:infrastructure:validate
npm run deployment:cloud-run:validate
npm run queue:health:validate
```

Las validaciones con `--live` se ejecutan solo cuando ya existen recursos de
nube y credenciales privadas. Nunca copies una configuracion de produccion al
repositorio publico.

## Observabilidad y retencion

El monitor revisa profundidad de colas, edad de jobs, reintentos y uso de B3.
Las politicas de retencion cubren imagenes, artefactos de navegador, comandos,
candidatos y jobs abandonados. Primero se debe ejecutar en modo de simulacion;
el borrado final necesita una confirmacion explicita del operador.
