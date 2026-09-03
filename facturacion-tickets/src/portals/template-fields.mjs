import { formatValue } from "../shared/value-formatters.mjs";

export function resolveTemplateFields(template, source) {
  const requiredFields = normalizeRequiredFields(template.requiredFields);
  const resolved = {};
  const missingFields = [];

  for (const field of requiredFields) {
    const value = readPath(source, field.source);

    if (isMissing(value)) {
      if (field.optional) {
        resolved[field.name] = "";
      } else {
        missingFields.push(field);
      }
    } else {
      resolved[field.name] = formatValue(value, field.format);
    }
  }

  return {
    requiredFields,
    missingFields,
    resolved,
  };
}

function normalizeRequiredFields(fields = []) {
  return fields.map((field) => {
    if (typeof field === "string") {
      return {
        name: field,
        source: field,
        label: field,
      };
    }

    return {
      name: field.name,
      source: field.source ?? field.name,
      label: field.label ?? field.name,
      format: field.format,
      optional: field.optional === true || field.name === "taxInteriorNumber" || field.source === "taxProfile.interiorNumber",
    };
  });
}

function readPath(source, path) {
  return path.split(".").reduce((current, key) => current?.[key], source);
}

function isMissing(value) {
  if (value === null || value === undefined) {
    return true;
  }

  if (typeof value === "string") {
    return value.trim() === "";
  }

  return false;
}
