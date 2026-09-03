import { formatValue, isSupportedValueFormat, listSupportedValueFormats } from "../shared/value-formatters.mjs";

const cases = [
  ["2026-05-18", "date:dd/mm/yyyy", "18/05/2026"],
  ["18/05/2026", "date:yyyy-mm-dd", "2026-05-18"],
  ["2026-05-18", "date:ddmmyyyy", "18052026"],
  [92, "number:fixed2", "92.00"],
  ["605 - Sueldos y Salarios", "taxRegime:code", "605"],
  ["S01 - Sin efectos fiscales", "cfdiUse:code", "S01"],
  [" XAXX010101000 ", "trim|rfc:uppercase", "XAXX010101000"],
  ["5400", "postalCode:5", "05400"],
  ["MEXICO", "state:mexico-portal", "ESTADO DE MEXICO"],
];
const errors = [];

for (const [input, format, expected] of cases) {
  const actual = formatValue(input, format);

  if (actual !== expected) {
    errors.push({ input, format, expected, actual });
  }
}

for (const format of listSupportedValueFormats()) {
  if (!isSupportedValueFormat(format)) {
    errors.push({ format, error: "format listed but not supported" });
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
      supportedFormats: listSupportedValueFormats(),
    },
    null,
    2,
  ),
);
