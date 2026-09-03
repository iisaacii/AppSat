# compiler_GPT

Compiler experimental para convertir aprendizaje de B3 (`browser-use`) en candidatos de receta A (`portal-template.v1` ejecutable por Playwright).

## Idea

`browser-use` resuelve portales con acciones visuales como:

```json
{ "input": { "index": 211, "text": "..." } }
```

Capa A necesita recetas deterministicas:

```json
{ "type": "fill", "selector": "#noTicket", "valueFrom": "ticketId" }
```

Este compilador usa:

- candidate B3 guardado en `data/portal-template-candidates`;
- `history.json` de B3/browser-use;
- bloque `Interactive elements` dentro del historial;
- schema A existente en `src/portals/template-schema.mjs`.

## Comandos

Validar imports:

```powershell
npm run compiler:gpt:validate
```

Compilar candidate B3:

```powershell
npm run compiler:gpt:compile -- --candidate=data/portal-template-candidates/SEM980701STA-www.e7-eleven.com.mx-b2_seven_ticket_local_lab-b3.candidate.json
```

Salida default:

```txt
data/portal-template-candidates/*-compiled-gpt.candidate.json
```

## Estados

- `compiled`: se pudo generar una receta A valida.
- `draft`: falta informacion para generar selectores estables.

El campo `learningState` explica el detalle:

- `compiled_ready_for_replay`;
- `compiled_dynamic_stop`;
- `needs_dom_map`;
- `compiler_failed`.

## Importante

Si el portal requiere CAPTCHA, el compiler puede generar pasos A hasta el punto seguro y luego un `stop` con `reason=captcha_required`. Eso permite que Capa A no se quede atorada y haga handoff a B/B3.

## Smoke Test Pinturerias

Candidate B3:

```powershell
npm run compiler:gpt:compile -- --candidate=data/portal-template-candidates/PMA1805167L1-facturacionpintu.com.mx-b2_pinturerias_ticket_pintura_lab-b3.candidate.json
```

Salida:

```txt
data/portal-template-candidates/PMA1805167L1-facturacionpintu.com.mx-b2_pinturerias_ticket_pintura_lab-b3-compiled-gpt.candidate.json
```

Resultado esperado:

- `status=compiled`;
- `learningState=compiled_ready_for_replay`;
- `unresolvedActions=0`;
- replay A llega hasta `finalSubmit`.

Comando de replay seguro:

```powershell
$env:PORTAL_RUNNER_MODE="playwright"
$env:HEADLESS="false"
$env:PORTAL_ALLOW_FINAL_SUBMIT="false"
npm run compiler:gpt:replay -- --candidate=data/portal-template-candidates/PMA1805167L1-facturacionpintu.com.mx-b2_pinturerias_ticket_pintura_lab-b3-compiled-gpt.candidate.json --fixture=data/stagehand-fixtures/pinturerias-ticket-pintura.json
```

La prueba debe detenerse con `template_safe_stop` si no hay aprobacion de envio final. Eso confirma que A reproduce la navegacion aprendida por B3 sin IA; no confirma descarga CFDI.
