import { loadPortalFamilies, loadPortalTemplates } from "../portals/portal-registry.mjs";
import { getPortalTemplateSchemaVersion } from "../portals/template-schema.mjs";

const families = [...(await loadPortalFamilies()).values()];
const templates = await loadPortalTemplates();

console.log(
  JSON.stringify(
    {
      schemaVersion: getPortalTemplateSchemaVersion(),
      families: families.map((family) => ({
        id: family.id,
        name: family.name,
        requiredFields: family.requiredFields.length,
        steps: family.steps.length,
        rateLimit: family.rateLimit ?? null,
      })),
      count: templates.length,
      templates: templates.map((template) => ({
        id: template.id,
        name: template.name,
        rfcEmisor: template.rfcEmisor,
        portalFamily: template.portalFamily ?? null,
        templateFamilyName: template.templateFamilyName ?? null,
        requiredFields: template.requiredFields.length,
        steps: template.steps.length,
        rateLimit: template.rateLimit ?? null,
      })),
    },
    null,
    2,
  ),
);
