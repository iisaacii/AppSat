import { validatePortalTemplate } from "../src/portals/template-schema.mjs";
import { compileB3CandidateToATemplate } from "./lib/template-compiler.mjs";

const minimalCandidate = {
  status: "candidate_cached",
  template: {
    schemaVersion: "portal-template.v1",
    id: "b3-learned-AAA010101AAA-example-com",
    name: "B3 learned AAA010101AAA",
    rfcEmisor: "AAA010101AAA",
    portalUrl: "https://example.com/facturacion",
    requiredFields: [
      {
        name: "ticketId",
        source: "ocrCandidates.ticketId",
        label: "Ticket",
      },
    ],
    steps: [],
    b3Learning: {
      selectedPortalUrl: "https://example.com/facturacion",
      actions: [
        {
          step: 1,
          type: "fill",
          browserUseIndex: 10,
          valueKey: "ticket.ticketId",
          stableSelectorRequired: true,
        },
      ],
    },
  },
};
const minimalHistory = {
  history: [
    {
      metadata: {
        step_number: 1,
      },
      state: {
        url: "https://example.com/facturacion",
        title: "Example",
      },
      state_message:
        "<browser_state>\nInteractive elements:\n[Start of page]\nTicket:\n[10]<input id=ticket name=ticket type=text required=true />\n[End of page]\n</browser_state>",
    },
  ],
};
const compiled = compileB3CandidateToATemplate({
  candidateDocument: minimalCandidate,
  historyDocument: minimalHistory,
});
const validation = validatePortalTemplate(compiled.template);

if (!validation.ok) {
  console.error(JSON.stringify(validation, null, 2));
  process.exit(1);
}

const downloadCandidate = {
  ...minimalCandidate,
  template: {
    ...minimalCandidate.template,
    b3Learning: {
      selectedPortalUrl: "https://example.com/facturacion",
      actions: [
        {
          step: 1,
          type: "fill",
          browserUseIndex: 10,
          valueKey: "ticket.ticketId",
          stableSelectorRequired: true,
        },
        {
          step: 2,
          type: "click",
          browserUseIndex: 20,
          stableSelectorRequired: true,
        },
        {
          step: 3,
          type: "click",
          browserUseIndex: 21,
          stableSelectorRequired: true,
        },
      ],
    },
  },
};
const downloadHistory = {
  history: [
    ...minimalHistory.history,
    {
      metadata: { step_number: 2 },
      state: {
        url: "https://example.com/facturacion",
        title: "Example",
      },
      state_message:
        "<browser_state>\nInteractive elements:\n[Start of page]\nVer/Guardar XML\n[20]<a id=downloadXml href=/cfdi.xml />\n[End of page]\n</browser_state>",
    },
    {
      metadata: { step_number: 3 },
      state: {
        url: "https://example.com/facturacion",
        title: "Example",
      },
      state_message:
        "<browser_state>\nInteractive elements:\n[Start of page]\nVisualizar Formato PDF\n[21]<a id=downloadPdf href=/cfdi.pdf />\n[End of page]\n</browser_state>",
    },
  ],
};
const compiledDownload = compileB3CandidateToATemplate({
  candidateDocument: downloadCandidate,
  historyDocument: downloadHistory,
});
const downloadStep = compiledDownload.template.steps.find((step) => step.type === "download");

if (
  !downloadStep ||
  downloadStep.xmlSelector !== "#downloadXml" ||
  downloadStep.pdfSelector !== "#downloadPdf" ||
  downloadStep.captureDownloads !== true
) {
  console.error(JSON.stringify(compiledDownload, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      compiler: "compiler_GPT",
      compiledSteps: compiled.template.steps.length,
      compiledDownload: {
        xmlSelector: downloadStep.xmlSelector,
        pdfSelector: downloadStep.pdfSelector,
      },
      status: compiled.status,
      learningState: compiled.learningState,
    },
    null,
    2,
  ),
);
