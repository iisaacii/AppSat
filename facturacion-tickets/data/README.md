# Datos versionados y datos privados

Esta carpeta solo guarda conocimiento publico o sintetico que hace falta para
ejecutar el codigo desde cero.

## Si se versiona

- `portal-url-directory.json` y `portal-url-directory-hashmap.json`: URLs de
  portales verificables y metadatos no personales.
- `tax-profiles/sample.json`: perfil fiscal sintetico para validaciones.

## Catalogo CFDI

`sat-catalogs/catCFDI_V_4_20260603.xls` es una copia de referencia de los
catalogos CFDI 4.0 del SAT. El servicio no lee el Excel en cada solicitud:
los valores que necesita estan materializados en
`src/fiscal/sat-cfdi-catalog.mjs` para responder rapido y sin depender de
Excel. Si llega una version nueva del catalogo, se debe regenerar ese modulo,
ejecutar `npm run release:preflight` y revisar el cambio antes de desplegarlo.

## No se versiona

- Fotos de tickets, QR extraidos o archivos subidos por usuarios.
- Perfiles fiscales reales, constancias SAT, RFC de personas o direcciones.
- XML/PDF, capturas, HTML, cookies, sesiones de navegador o trazas B3.
- Memoria aprendida de portales, cache Stagehand y candidatos en ejecucion.

En produccion estos datos viven en Firestore, Storage y el almacenamiento
privado elegido para conocimiento compartido. Las rutas ignoradas por Git se
definen en el `.gitignore` raiz.
