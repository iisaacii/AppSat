# Datos versionados y datos privados

Esta carpeta solo guarda conocimiento publico o sintetico que hace falta para
ejecutar el codigo desde cero.

## Si se versiona

- `portal-url-directory.json` y `portal-url-directory-hashmap.json`: URLs de
  portales verificables y metadatos no personales.
- `tax-profiles/sample.json`: perfil fiscal sintetico para validaciones.

## No se versiona

- Fotos de tickets, QR extraidos o archivos subidos por usuarios.
- Perfiles fiscales reales, constancias SAT, RFC de personas o direcciones.
- XML/PDF, capturas, HTML, cookies, sesiones de navegador o trazas B3.
- Memoria aprendida de portales, cache Stagehand y candidatos en ejecucion.

En produccion estos datos viven en Firestore, Storage y el almacenamiento
privado elegido para conocimiento compartido. Las rutas ignoradas por Git se
definen en el `.gitignore` raiz.
