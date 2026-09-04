# Declaracion mensual

Este modulo queda reservado para construir la declaracion mensual de AppSat.
Esta separado de `facturacion-tickets` para que sus reglas fiscales, fuentes de
datos, API, permisos y pruebas puedan evolucionar sin acoplarse al navegador de
portales de facturacion.

Estado actual: carpeta de inicio. Todavia no contiene logica de calculo ni se
publica como servicio.

## Referencias disponibles

- `referencias/Guia_Practica_Impuestos_Mexico.pdf`: material general de
  consulta para orientar el futuro diseno del modulo. No contiene perfiles de
  usuarios ni se usa automaticamente para calcular declaraciones.

Las obligaciones, tasas y reglas fiscales deberan verificarse contra fuentes
oficiales vigentes cuando comience la implementacion. Este material no debe
tratarse como una fuente normativa permanente.

Cuando comience su desarrollo debera incluir, como minimo, contrato de datos,
fuentes permitidas, calculos auditables, validaciones, retencion de datos y su
propio README operativo.
