# Facturacion de tickets

Backend independiente para recibir tickets, extraer datos, encontrar el portal
de facturacion y entregar el CFDI.

## Flujo

```text
foto + perfil fiscal
  -> API V2
  -> OCR
  -> portal discovery
  -> Capa A
  -> B3 si A no resuelve
  -> Capa C si se necesita una persona
  -> XML/PDF
```

## Desarrollo local

Requisitos: Node.js 20 o posterior y Python 3 para B3.

```powershell
npm install
npm run contract:validate
npm run api:v2:validate
```

La API HTTP local se inicia con:

```powershell
npm run api:serve
```

## Integracion HTTP

La guia para consumir la API esta en:
`docs/BILLING_API_V2_INTEGRATION_GUIDE.md`.

El contrato formal esta en `docs/openapi.billing.v2.json`.

## Datos sensibles

No subir `.env`, `secrets/`, fotos, perfiles fiscales reales, artefactos de
navegador, logs ni resultados de facturacion al repositorio publico.
