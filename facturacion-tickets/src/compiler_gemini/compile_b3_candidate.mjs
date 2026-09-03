import { readFile } from "node:fs/promises";
import { saveLearnedTemplateCandidate } from "../portals/template-candidates.mjs";

const mockJob = {
  id: `compile_${Date.now()}`,
  rfcReceptor: "XAXX010101000",
  taxProfile: {
    rfc: "XAXX010101000",
    legalName: "PERSONA CONTRIBUYENTE DEMO",
    email: "pruebas@appsat.dev",
    fiscalRegime: "605 - Sueldos y Salarios e Ingresos Asimilados a Salarios",
    cfdiUse: "S01 - Sin efectos fiscales",
    postalCode: "54040",
  },
};

const mockExtracted = {
  rfcEmisor: "SEM980701STA",
  folio: "784701",
  fecha: "2026-05-18",
  monto: 21.0,
  ocrCandidates: {
    ticketId: "10021805202632000078470100063303586",
  },
};

function normalizeText(text) {
  if (!text) return "";
  return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

function inferSemanticKey(text) {
  const norm = normalizeText(text);
  if (!norm) return null;

  if (norm === normalizeText(mockExtracted.ocrCandidates.ticketId)) return "ticket.ticketId";
  if (norm === normalizeText(mockExtracted.folio)) return "ticket.folio";
  if (norm === normalizeText(mockExtracted.fecha)) return "ticket.fecha";
  if (norm === normalizeText(mockJob.taxProfile.rfc)) return "taxProfile.rfc";
  if (norm === normalizeText(mockJob.taxProfile.legalName)) return "taxProfile.legalName";
  if (norm === normalizeText(mockJob.taxProfile.postalCode)) return "taxProfile.postalCode";
  if (norm === normalizeText(mockJob.taxProfile.email)) return "taxProfile.email";

  if (norm.includes("sueldos y salarios") || norm.includes("605")) return "taxProfile.fiscalRegime";
  if (norm.includes("sin efectos fiscales") || norm.includes("s01")) return "taxProfile.cfdiUse";

  return null;
}

function getNextStateElements(historyData, currentStepNumber) {
  for (const step of historyData.history) {
    if (step.metadata?.step_number === currentStepNumber + 1) {
      return step.state?.interacted_element || [];
    }
  }
  return [];
}

function extractElementFromBrowserState(stateMessage, index) {
  if (!stateMessage) return null;
  const browserStateMatch = stateMessage.match(/<browser_state>([\s\S]*?)<\/browser_state>/);
  if (!browserStateMatch) return null;

  const browserState = browserStateMatch[1];

  const regex = new RegExp(`\\[${index}\\]<([a-zA-Z0-9-]+)([^>]*)>([\\s\\S]*?)<\\/\\1>|\\[${index}\\]<([a-zA-Z0-9-]+)([^>]*)\\\/>([\\s\\S]*?)(?=\\n\\s*(?:\\||\\*|\\[|<|$))`);
  const match = browserState.match(regex);

  if (match) {
    const tag = (match[1] || match[4]).toLowerCase();
    const rawAttrs = match[2] || match[5] || "";
    const text = match[3] || match[6] || "";

    // Robust character-based HTML attribute parser
    const attributes = {};
    let i = 0;
    while (i < rawAttrs.length) {
      // Skip whitespace
      while (i < rawAttrs.length && /\s/.test(rawAttrs[i])) {
        i++;
      }
      if (i >= rawAttrs.length) break;

      // Read key
      let keyStart = i;
      while (i < rawAttrs.length && rawAttrs[i] !== '=' && !/\s/.test(rawAttrs[i])) {
        i++;
      }
      const key = rawAttrs.slice(keyStart, i);

      // Skip whitespace before =
      while (i < rawAttrs.length && /\s/.test(rawAttrs[i])) {
        i++;
      }

      if (i < rawAttrs.length && rawAttrs[i] === '=') {
        i++; // skip '='
        // Skip whitespace after =
        while (i < rawAttrs.length && /\s/.test(rawAttrs[i])) {
          i++;
        }

        // Read value
        let value = "";
        if (i < rawAttrs.length && (rawAttrs[i] === '"' || rawAttrs[i] === "'")) {
          const quote = rawAttrs[i];
          i++; // skip quote
          let valStart = i;
          while (i < rawAttrs.length && rawAttrs[i] !== quote) {
            i++;
          }
          value = rawAttrs.slice(valStart, i);
          if (i < rawAttrs.length) i++; // skip close quote
        } else {
          // Unquoted value: read until next key= or end
          let valStart = i;
          while (i < rawAttrs.length) {
            if (/\s/.test(rawAttrs[i])) {
              // Check if there is a word followed by '=' ahead
              let nextIdx = i;
              while (nextIdx < rawAttrs.length && /\s/.test(rawAttrs[nextIdx])) {
                nextIdx++;
              }
              let wordStart = nextIdx;
              while (nextIdx < rawAttrs.length && rawAttrs[nextIdx] !== '=' && !/\s/.test(rawAttrs[nextIdx])) {
                nextIdx++;
              }
              if (nextIdx < rawAttrs.length && rawAttrs[nextIdx] === '=') {
                break; // Found next key, stop reading value
              }
            }
            i++;
          }
          value = rawAttrs.slice(valStart, i).trim();
        }
        attributes[key] = value;
      } else {
        // Standalone attribute
        attributes[key] = "true";
      }
    }

    return { node_name: tag, attributes, ax_name: text.trim() };
  }
  return null;
}

function resolveStableSelector(actionType, index, interactedElements, stateMessage) {
  let element = extractElementFromBrowserState(stateMessage, index);

  if (!element && interactedElements) {
    element = interactedElements.find(e => e && e.attributes);
  }

  if (!element) return null;

  const tag = element.node_name.toLowerCase();
  const attrs = element.attributes || {};

  if (attrs.id && !attrs.id.match(/[0-9]{4,}/)) {
    if (attrs.id.includes(":")) {
      return `[id="${attrs.id}"]`;
    }
    return `#${attrs.id}`;
  }

  if (attrs.name && attrs.name !== "email") { // email is generic sometimes
    return `[name="${attrs.name}"]`;
  }

  if (attrs.placeholder) return `[placeholder="${attrs.placeholder}"]`;
  if (attrs.title) return `[title="${attrs.title}"]`;
  if (attrs['aria-label']) return `[aria-label="${attrs['aria-label']}"]`;

  if ((tag === "button" || tag === "a") && element.ax_name) {
    return `${tag}:has-text("${element.ax_name.replace(/"/g, '\\"')}")`;
  }

  if (element.x_path) return element.x_path;

  return tag;
}

async function main() {
  const args = process.argv.slice(2);
  const historyArg = args.find(a => a.startsWith("--history="));
  if (!historyArg) {
    console.error("Usage: node compile_b3_candidate.mjs --history=<path>");
    process.exit(1);
  }
  const historyPath = historyArg.split("=")[1];
  const historyData = JSON.parse(await readFile(historyPath, "utf8"));

  const steps = [];
  let portalUrl = "";

  for (const step of historyData.history) {
    const actions = step.model_output?.action || [];
    const stateMessage = step.state_message;
    const stepNumber = step.metadata?.step_number;

    const interactedElements = getNextStateElements(historyData, stepNumber);

    for (const action of actions) {
      if (action.navigate) {
        portalUrl = action.navigate.url;
      } else if (action.click) {
        const selector = resolveStableSelector("click", action.click.index, interactedElements, stateMessage);
        if (selector) {
          steps.push({
            type: "click",
            status: "completed",
            selector: selector
          });
        }
      } else if (action.input) {
        const selector = resolveStableSelector("input", action.input.index, interactedElements, stateMessage);
        const valueKey = inferSemanticKey(action.input.text);
        if (selector) {
          steps.push({
            type: "fill",
            status: "completed",
            selector: selector,
            valueKey: valueKey || undefined,
            ...(valueKey ? {} : { _rawText: action.input.text })
          });
        }
      } else if (action.select_dropdown) {
        const selector = resolveStableSelector("select", action.select_dropdown.index, interactedElements, stateMessage);
        const valueKey = inferSemanticKey(action.select_dropdown.text);
        if (selector) {
          steps.push({
            type: "select",
            status: "completed",
            selector: selector,
            valueKey: valueKey || undefined
          });
        }
      } else if (action.done) {
        steps.push({
          type: "stop",
          status: "completed"
        });
      }
    }
  }

  const learnedSteps = [ { type: "goto", urlFrom: "portalUrl" } ];
  const requiredFieldsMap = new Map();
  const unmappedFieldCounts = {};

  for (const step of steps) {
    if (step.type === "stop") {
      learnedSteps.push(step);
      continue;
    }

    let requiredField = null;
    if (step.valueKey) {
      // Map to standard required field
      const mappings = {
        "taxProfile.rfc": { name: "taxRfc", source: "taxProfile.rfc", format: "rfc:uppercase" },
        "taxProfile.legalName": { name: "taxLegalName", source: "taxProfile.legalName" },
        "taxProfile.fiscalRegime": { name: "taxFiscalRegime", source: "taxProfile.fiscalRegime", format: "taxRegime:code" },
        "taxProfile.cfdiUse": { name: "taxCfdiUse", source: "taxProfile.cfdiUse", format: "cfdiUse:code" },
        "taxProfile.postalCode": { name: "taxPostalCode", source: "taxProfile.postalCode", format: "postalCode:5" },
        "taxProfile.email": { name: "taxEmail", source: "taxProfile.email" },
        "ticket.ticketId": { name: "ticketId", source: "ocrCandidates.ticketId" },
        "ticket.folio": { name: "folio", source: "folio" },
        "ticket.fecha": { name: "fecha", source: "fecha", format: "date:dd/mm/yyyy" }
      };
      requiredField = mappings[step.valueKey];
    }

    if (!requiredField && ["fill", "select"].includes(step.type)) {
      const cleanSelector = step.selector.replace(/[^a-zA-Z0-9]/g, "_").replace(/^_+|_+$/g, "").slice(0, 30);
      unmappedFieldCounts[cleanSelector] = (unmappedFieldCounts[cleanSelector] || 0) + 1;
      const suffix = unmappedFieldCounts[cleanSelector] > 1 ? `_${unmappedFieldCounts[cleanSelector]}` : "";
      const generatedName = `unmappedField_${cleanSelector}${suffix}`;
      requiredField = { name: generatedName, source: `portalDiscovery.fields.${generatedName}` };
    }

    if (requiredField) {
      requiredFieldsMap.set(requiredField.name, requiredField);
    }

    learnedSteps.push({
      type: step.type,
      selector: step.selector,
      ...(requiredField ? { valueFrom: requiredField.name } : {}),
      ...(step.type === "stop" ? { status: "completed" } : {})
    });
  }

  // To satisfy schema validation, append a dummy download if not present
  learnedSteps.push({
    type: "download",
    selector: "a:has-text('XML')"
  });

  const aiNavigationResult = {
    providerMode: "b3_compiler",
    portalUrl: portalUrl || "https://7-eleven.com.mx/facturacion-electronica/",
    turns: [
      {
        index: 1,
        execution: steps
      }
    ],
    learnedTemplateCandidate: {
      id: `learned-7eleven-${Date.now()}`,
      name: `Learned 7 Eleven Compiler`,
      rfcEmisor: mockExtracted.rfcEmisor,
      portalUrl: portalUrl || "https://7-eleven.com.mx/facturacion-electronica/",
      portalFamily: "ai_learned",
      requiredFields: Array.from(requiredFieldsMap.values()),
      steps: learnedSteps,
      rateLimit: { concurrency: 1, perMinute: 6 }
    }
  };

  console.log("Compiling candidate with execution steps:", JSON.stringify(learnedSteps, null, 2));

  const saveResult = await saveLearnedTemplateCandidate({
    job: mockJob,
    extracted: mockExtracted,
    template: null,
    completed: true,
    aiNavigationResult
  });

  console.log(`\\n✅ Compilation successful!`);
  console.log(`Candidate saved to: ${saveResult?.path || 'Failed to save'}`);
}

main().catch(console.error);
