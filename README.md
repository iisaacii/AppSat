# AppSat

AppSat contiene los servicios fiscales que se estan construyendo como backend
independiente. El primer modulo listo para integracion tecnica es la
facturacion automatizada de tickets. El segundo modulo reserva el espacio para
la declaracion mensual.

## Que hay en este repositorio

| Carpeta | Estado | Proposito |
| --- | --- | --- |
| `facturacion-tickets/` | En desarrollo activo | API, workers y automatizacion para convertir una foto de ticket en CFDI XML y, cuando el portal lo entrega, PDF. |
| `declaracion-mensual/` | Planeada | Espacio aislado para construir despues la declaracion mensual. Aun no tiene logica de produccion. |

No hay aplicacion Flutter ni frontend en este repositorio. Una aplicacion
externa envia la foto y el perfil fiscal a la API de facturacion y consulta el
resultado de forma asincrona.

## Como funciona la facturacion

```text
Aplicacion o backend integrador
  -> foto del ticket + perfil fiscal
  -> API V2 de AppSat crea un job
  -> OCR autonomo y candidatos validados
  -> deteccion del portal de facturacion
  -> Capa A: receta rapida para portales conocidos
  -> B3: navegador con IA si el portal es nuevo o cambio
  -> CFDI XML/PDF, o Capa C si una persona debe intervenir
```

La solicitud HTTP inicial responde rapido con un `jobId`. La generacion de la
factura ocurre en workers separados; la integracion consulta ese `jobId` hasta
recibir un resultado final.

## Inicio rapido local

Requisitos: Node.js 20 o posterior, Docker Desktop para ejecutar Redis y los
workers, y Python 3 para B3.

```powershell
cd facturacion-tickets
npm ci
Copy-Item .env.example .env
npm run release:preflight
docker compose --profile workers up --build
```

Completa `.env` y `secrets/firebase-service-account.json` solo en tu maquina o
en el gestor de secretos del despliegue. No los agregues a Git.

## Firebase de AppSat

La raiz del repositorio contiene la configuracion propia de Firebase para este
servicio:

| Archivo | Funcion |
| --- | --- |
| `firebase.json` | Vincula las reglas e indices que deben desplegarse juntos. |
| `firestore.rules` | Permite que cada usuario autenticado lea solo sus jobs; la API y los workers escriben mediante Admin SDK. |
| `storage.rules` | Protege tickets, CFDI y artefactos por usuario; las rutas internas de la API quedan fuera del acceso directo del cliente. |
| `firestore.indexes.json` | Declara las consultas de jobs y comandos que necesitan indice. |
| `firebase.security-test.json` | Configura emuladores para validar las reglas sin tocar datos reales. |

Antes de desplegar reglas o indices, selecciona explicitamente el proyecto
Firebase de AppSat. Las reglas se pueden comprobar localmente desde
`facturacion-tickets/` con `npm run security:rules:validate`.

## Documentacion

- [Facturacion de tickets](facturacion-tickets/README.md): operacion local,
  arquitectura y pruebas.
- [Arquitectura](facturacion-tickets/ARCHITECTURE.md): recorrido completo de
  un job, capas A/B3/C y componentes de escala.
- [Contrato HTTP V2](facturacion-tickets/docs/BILLING_API_V2_INTEGRATION_GUIDE.md):
  como enviar una foto y consultar XML/PDF desde otro backend.
- [Capa C](facturacion-tickets/docs/CAPA_C_USER_ACTION.md): que sucede cuando
  un portal pide CAPTCHA, login o una correccion humana.
- [Despliegue](facturacion-tickets/deployment/README.md): API, workers, Redis
  y Cloud Run.

## Seguridad y datos fiscales

El repositorio publico contiene solo ejemplos sinteticos. Estan excluidos de
Git los tickets, perfiles fiscales reales, credenciales Firebase, claves de
Gemini, cookies, capturas del navegador, XML/PDF y memoria aprendida de los
portales. Los resultados reales deben almacenarse en infraestructura privada
con permisos minimos y politicas de retencion.

## Estado de la migracion

La rama `main` de este repositorio es el origen de AppSat. La configuracion de
ejemplo, Docker Compose y los manifiestos nuevos usan prefijos `appsat-*`; los
valores de produccion siguen siendo configurables mediante variables de
entorno. Ningun secreto ni dato fiscal real fue migrado.
