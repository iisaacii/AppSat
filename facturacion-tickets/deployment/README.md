# Despliegue de facturacion

Este modulo puede ejecutarse localmente o desplegarse como una API y workers
separados. La API recibe el ticket y el perfil fiscal; los workers procesan OCR,
portal y acciones manuales de Capa C mediante una cola compartida.

## Imagenes

- `Dockerfile`: API HTTP.
- `Dockerfile.worker-ocr`: worker de OCR.
- `Dockerfile.worker-browser`: worker de portales A/B3.

## Configuracion

Usa variables de entorno o un gestor de secretos del proveedor. No guardes
claves Firebase, API keys, tokens, certificados, perfiles fiscales ni fotos en
Git. En produccion, usa una identidad de servicio con permisos minimos y
referencia las imagenes por digest, no por `latest`.

## Escala

La API puede escalar horizontalmente. Los workers deben usar Redis/BullMQ o el
transporte distribuido equivalente para evitar que dos instancias procesen el
mismo job. Mantén la concurrencia del navegador en uno por portal hasta medir
los limites del sitio externo.

## Verificacion

Desde `facturacion-tickets` ejecuta las validaciones del contrato, portal,
OCR, cola y despliegue antes de publicar una version.
