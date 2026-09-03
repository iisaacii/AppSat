import { buildFiscalComplianceContext, inferPersonTypeFromRfc } from "../fiscal/fiscal-compliance.service.mjs";

const cases = [
  {
    name: "persona fisica 605 S01",
    profile: {
      rfc: "XAXX010101000",
      fiscalRegime: "605 - Sueldos y Salarios e Ingresos Asimilados a Salarios",
      cfdiUse: "S01 - Sin efectos fiscales",
    },
    expected: {
      ready: true,
      personType: "fisica",
      regimeCode: "605",
      cfdiUseCode: "S01",
    },
  },
  {
    name: "persona moral 601 S01",
    profile: {
      rfc: "ABC010101AB1",
      fiscalRegime: "601 - General de Ley Personas Morales",
      cfdiUse: "S01 - Sin efectos fiscales",
    },
    expected: {
      ready: true,
      personType: "moral",
      regimeCode: "601",
      cfdiUseCode: "S01",
    },
  },
  {
    name: "regimen moral en RFC fisica bloquea",
    profile: {
      rfc: "XAXX010101000",
      fiscalRegime: "601 - General de Ley Personas Morales",
      cfdiUse: "S01 - Sin efectos fiscales",
    },
    expected: {
      ready: false,
      reason: "tax_profile_regime_person_type_mismatch",
    },
  },
  {
    name: "uso CFDI desconocido bloquea",
    profile: {
      rfc: "XAXX010101000",
      fiscalRegime: "605 - Sueldos y Salarios e Ingresos Asimilados a Salarios",
      cfdiUse: "ZZZ - Uso inexistente",
    },
    expected: {
      ready: false,
      reason: "tax_profile_cfdi_use_unknown",
    },
  },
];

const errors = [];

if (inferPersonTypeFromRfc("XAXX010101000") !== "fisica") {
  errors.push({ name: "infer fisica", expected: "fisica", actual: inferPersonTypeFromRfc("XAXX010101000") });
}

if (inferPersonTypeFromRfc("ABC010101AB1") !== "moral") {
  errors.push({ name: "infer moral", expected: "moral", actual: inferPersonTypeFromRfc("ABC010101AB1") });
}

for (const item of cases) {
  const actual = buildFiscalComplianceContext(item.profile);

  if (actual.ready !== item.expected.ready) {
    errors.push({ name: item.name, field: "ready", expected: item.expected.ready, actual: actual.ready, actual });
  }

  if (item.expected.personType && actual.personType !== item.expected.personType) {
    errors.push({ name: item.name, field: "personType", expected: item.expected.personType, actual: actual.personType });
  }

  if (item.expected.regimeCode && actual.expectedFiscalRegime?.code !== item.expected.regimeCode) {
    errors.push({
      name: item.name,
      field: "expectedFiscalRegime.code",
      expected: item.expected.regimeCode,
      actual: actual.expectedFiscalRegime?.code,
    });
  }

  if (item.expected.cfdiUseCode && actual.expectedCfdiUse?.code !== item.expected.cfdiUseCode) {
    errors.push({
      name: item.name,
      field: "expectedCfdiUse.code",
      expected: item.expected.cfdiUseCode,
      actual: actual.expectedCfdiUse?.code,
    });
  }

  if (item.expected.reason && actual.reason !== item.expected.reason) {
    errors.push({ name: item.name, field: "reason", expected: item.expected.reason, actual: actual.reason, actual });
  }
}

if (errors.length) {
  console.error(JSON.stringify({ ok: false, errors }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      cases: cases.length,
      sample: buildFiscalComplianceContext(cases[0].profile),
    },
    null,
    2,
  ),
);
