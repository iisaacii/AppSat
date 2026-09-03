# Compilador B3 a Capa A

Este componente transforma una corrida exitosa de B3 en un candidato de receta
determinista para Capa A.

```text
B3 navega y resuelve un portal
  -> historial + evidencia de elementos interactivos
  -> compiler_GPT genera portal-template.v1
  -> replay con Playwright sin IA
  -> candidato puede promoverse a receta A
```

La idea es que la siguiente factura del mismo emisor use selectores y pasos
rapidos en vez de gastar una nueva sesion de IA.

## Entradas y salida

Entrada privada:

- candidato B3;
- historial de browser-use;
- mapa de elementos interactivos y evidencia del portal.

Salida privada:

- `*-compiled-gpt.candidate.json` con receta compatible con
  `portal-template.v1`;
- estado de aprendizaje y pasos que no pudieron compilarse.

Estas rutas estan ignoradas en Git porque pueden contener sesiones, selectores
fragiles y datos de ticket. Solo el codigo del compilador se publica.

## Comandos

```powershell
npm run compiler:gpt:validate
npm run compiler:gpt:compile -- --candidate=data/portal-template-candidates/<candidate>.json
npm run compiler:gpt:replay -- --candidate=data/portal-template-candidates/<candidate>.json --fixture=<ticket>.json
```

Un replay exitoso demuestra que A puede repetir la navegacion sin IA. No se
promueve una receta solo por compilarla: se conserva evidencia y se valida el
resultado antes de marcarla activa.

Para CAPTCHA o login, el compilador puede generar pasos hasta el punto seguro y
un `stop` tipado. Eso permite que el router vaya a Capa C sin reintentar B3
innecesariamente.
