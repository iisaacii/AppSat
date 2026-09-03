export function evaluateTemplatePreflight(template, source, options = {}) {
  const rules = Array.isArray(template.preflightRules) ? template.preflightRules : [];

  for (const rule of rules) {
    const result = evaluatePreflightRule(rule, source, options);

    if (result?.blocked) {
      return result;
    }
  }

  return {
    blocked: false,
  };
}

function evaluatePreflightRule(rule, source, options) {
  if (rule.type === "dateYearEqualsCurrent") {
    return evaluateDateYearEqualsCurrent(rule, source, options);
  }

  return {
    blocked: false,
  };
}

function evaluateDateYearEqualsCurrent(rule, source, options) {
  const fieldPath = rule.source ?? rule.field;
  const value = readPath(source, fieldPath);
  const ticketYear = parseDateYear(value);
  const currentYear = getReferenceDate(options).getFullYear();

  if (!ticketYear || ticketYear === currentYear) {
    return {
      blocked: false,
    };
  }

  return {
    blocked: true,
    status: rule.status ?? "needs_user_action",
    statusMessage:
      rule.message ??
      `El ticket pertenece al ejercicio fiscal ${ticketYear}; el ejercicio fiscal actual es ${currentYear}.`,
    reason: rule.reason ?? "preflight_rule_blocked",
    ruleType: rule.type,
    details: {
      field: fieldPath,
      value,
      ticketYear,
      currentYear,
    },
  };
}

function getReferenceDate(options) {
  if (options.now instanceof Date) {
    return options.now;
  }

  if (options.now) {
    const date = new Date(options.now);
    return Number.isNaN(date.getTime()) ? new Date() : date;
  }

  return new Date();
}

function parseDateYear(value) {
  if (value instanceof Date) {
    return value.getFullYear();
  }

  const text = String(value ?? "").trim();
  const isoMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);

  if (isoMatch) {
    return Number(isoMatch[1]);
  }

  const dayFirstMatch = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);

  if (dayFirstMatch) {
    return Number(dayFirstMatch[3]);
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getFullYear();
}

function readPath(source, path) {
  if (!path) {
    return undefined;
  }

  return path.split(".").reduce((current, key) => current?.[key], source);
}
