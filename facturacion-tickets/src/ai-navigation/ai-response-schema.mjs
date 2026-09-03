export const aiNavigationResponseSchema = {
  type: "object",
  properties: {
    status: { type: "string" },
    confidence: { type: "number" },
    reason: { type: "string" },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string" },
          selector: { type: "string" },
          text: { type: "string" },
          exact: { type: "boolean" },
          valueKey: { type: "string" },
          value: { type: "string" },
          format: { type: "string" },
          checked: { type: "boolean" },
          state: { type: "string" },
          timeoutMs: { type: "integer" },
          xmlSelector: { type: "string" },
          pdfSelector: { type: "string" },
          reason: { type: "string" },
        },
        required: ["type", "reason"],
      },
    },
    learnedTemplateCandidate: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        rfcEmisor: { type: "string" },
        portalUrl: { type: "string" },
        portalFamily: { type: "string" },
        requiredFields: {
          type: "array",
          items: { type: "object" },
        },
        steps: {
          type: "array",
          items: { type: "object" },
        },
      },
    },
  },
  required: ["status", "confidence", "reason", "actions"],
};
