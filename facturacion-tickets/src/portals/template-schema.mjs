const schemaVersion = "portal-template.v1";

const allowedStepTypes = new Set([
  "goto",
  "fill",
  "setValue",
  "select",
  "selectOrStop",
  "check",
  "click",
  "finalSubmit",
  "dispatchClick",
  "clickText",
  "waitForSelector",
  "waitForSelectorOrStop",
  "waitForText",
  "waitForUrl",
  "waitForLoadState",
  "extractAttribute",
  "download",
  "stop",
]);

const selectorSteps = new Set([
  "fill",
  "setValue",
  "select",
  "selectOrStop",
  "check",
  "click",
  "finalSubmit",
  "dispatchClick",
  "waitForSelector",
  "waitForSelectorOrStop",
  "extractAttribute",
  "download",
]);

const valueSteps = new Set(["fill", "setValue", "select", "selectOrStop"]);
const allowedPreflightRuleTypes = new Set(["dateYearEqualsCurrent"]);
const knownFormatPattern =
  /^(trim|uppercase|lowercase|digits|rfc:uppercase|postalCode:5|taxRegime:code|cfdiUse:code|date:(dd\/mm\/yyyy|dd-mm-yyyy|yyyy-mm-dd|yyyy\/mm\/dd|ddmmyyyy|mm\/dd\/yyyy)|number:(fixed0|fixed2|plain)|state:mexico-portal)$/;

export function validatePortalTemplate(template) {
  const errors = [];

  requireString(template, "id", errors);
  requireString(template, "name", errors);
  requireString(template, "rfcEmisor", errors);
  requireString(template, "portalUrl", errors);
  validateExecutableRecipe(template, errors);

  if (template.schemaVersion !== schemaVersion) {
    errors.push(`schemaVersion must be ${schemaVersion}`);
  }

  if (template.rateLimit) {
    requireNumber(template.rateLimit, "concurrency", errors, "rateLimit");
    requireNumber(template.rateLimit, "perMinute", errors, "rateLimit");
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function validatePortalFamily(family) {
  const errors = [];

  requireString(family, "id", errors);
  requireString(family, "name", errors);
  validateExecutableRecipe(family, errors);

  if (family.schemaVersion !== schemaVersion) {
    errors.push(`schemaVersion must be ${schemaVersion}`);
  }

  if (family.rateLimit) {
    requireNumber(family.rateLimit, "concurrency", errors, "rateLimit");
    requireNumber(family.rateLimit, "perMinute", errors, "rateLimit");
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function assertPortalTemplate(template) {
  const result = validatePortalTemplate(template);

  if (!result.ok) {
    throw new Error(`Invalid portal template ${template.id ?? "(missing id)"}: ${result.errors.join("; ")}`);
  }

  return template;
}

export function assertPortalFamily(family) {
  const result = validatePortalFamily(family);

  if (!result.ok) {
    throw new Error(`Invalid portal family ${family.id ?? "(missing id)"}: ${result.errors.join("; ")}`);
  }

  return family;
}

export function getPortalTemplateSchemaVersion() {
  return schemaVersion;
}

function validateExecutableRecipe(recipe, errors) {
  requireArray(recipe, "requiredFields", errors);
  requireArray(recipe, "steps", errors);
  validateRequiredFields(recipe.requiredFields ?? [], errors);
  validateSteps(recipe.steps ?? [], errors);

  if (recipe.preflightRules !== undefined) {
    requireArray(recipe, "preflightRules", errors);
    validatePreflightRules(Array.isArray(recipe.preflightRules) ? recipe.preflightRules : [], errors);
  }
}

function validateRequiredFields(fields, errors) {
  fields.forEach((field, index) => {
    const prefix = `requiredFields[${index}]`;

    if (typeof field === "string") {
      return;
    }

    requireString(field, "name", errors, prefix);
    requireString(field, "source", errors, prefix);

    if (field.format !== undefined) {
      validateFormat(field.format, errors, `${prefix}.format`);
    }
  });
}

function validateFormat(format, errors, prefix) {
  const formats = Array.isArray(format)
    ? format
    : String(format)
        .split("|")
        .map((item) => item.trim())
        .filter(Boolean);

  if (!formats.length) {
    errors.push(`${prefix} must not be empty`);
    return;
  }

  for (const item of formats) {
    if (!knownFormatPattern.test(item)) {
      errors.push(`${prefix} unsupported: ${item}`);
    }
  }
}

function validateSteps(steps, errors) {
  steps.forEach((step, index) => {
    const prefix = `steps[${index}]`;

    if (!allowedStepTypes.has(step.type)) {
      errors.push(`${prefix}.type unsupported: ${step.type}`);
    }

    if (selectorSteps.has(step.type)) {
      requireString(step, "selector", errors, prefix);
    }

    if (valueSteps.has(step.type)) {
      requireString(step, "valueFrom", errors, prefix);
    }

    if (step.type === "goto" && !step.url && !step.urlFrom) {
      errors.push(`${prefix} requires url or urlFrom`);
    }

    if (step.type === "waitForText" && !hasString(step, "text") && !hasString(step, "textFrom")) {
      errors.push(`${prefix} requires text or textFrom`);
    }

    if (step.type === "clickText" && !hasString(step, "text") && !hasString(step, "textFrom")) {
      errors.push(`${prefix} requires text or textFrom`);
    }

    if (step.type === "waitForUrl") {
      requireString(step, "url", errors, prefix);
    }

    if (step.type === "extractAttribute") {
      requireString(step, "attribute", errors, prefix);
      requireString(step, "saveAs", errors, prefix);
    }
  });
}

function validatePreflightRules(rules, errors) {
  rules.forEach((rule, index) => {
    const prefix = `preflightRules[${index}]`;

    requireString(rule, "type", errors, prefix);

    if (!allowedPreflightRuleTypes.has(rule.type)) {
      errors.push(`${prefix}.type unsupported: ${rule.type}`);
    }

    if (rule.type === "dateYearEqualsCurrent" && !hasString(rule, "field") && !hasString(rule, "source")) {
      errors.push(`${prefix} requires field or source`);
    }
  });
}

function hasString(source, key) {
  return typeof source?.[key] === "string" && source[key].trim() !== "";
}

function requireString(source, key, errors, prefix = "") {
  if (typeof source?.[key] !== "string" || source[key].trim() === "") {
    errors.push(`${fieldName(prefix, key)} must be a non-empty string`);
  }
}

function requireArray(source, key, errors, prefix = "") {
  if (!Array.isArray(source?.[key])) {
    errors.push(`${fieldName(prefix, key)} must be an array`);
  }
}

function requireNumber(source, key, errors, prefix = "") {
  if (typeof source?.[key] !== "number") {
    errors.push(`${fieldName(prefix, key)} must be a number`);
  }
}

function fieldName(prefix, key) {
  return prefix ? `${prefix}.${key}` : key;
}
