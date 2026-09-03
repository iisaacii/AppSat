# AppSat

Repositorio principal para los servicios fiscales de AppSat.

## Modulos

- `facturacion-tickets/`: recibe una foto y el perfil fiscal, ejecuta OCR,
  descubre el portal, intenta Capa A/B3/C y entrega el CFDI.
- `declaracion-mensual/`: espacio separado para construir la declaracion
  mensual. Todavia no contiene logica de produccion.

## Inicio rapido de facturacion

```powershell
cd facturacion-tickets
npm install
npm run contract:validate
npm run api:v2:validate
```

El servicio es asincrono: la API crea un job y el cliente consulta su estado
hasta recibir XML/PDF o una accion requerida.

La guia de integracion esta en:
`facturacion-tickets/docs/BILLING_API_V2_INTEGRATION_GUIDE.md`.

## Seguridad

- No subir `.env`, credenciales, tokens, certificados, fotos de tickets ni
  perfiles fiscales reales.
- Las credenciales se configuran fuera del repositorio.
- Las imagenes, resultados y trazas de ejecucion deben permanecer en storage
  privado.
