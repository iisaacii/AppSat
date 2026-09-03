import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getStagehandCacheDir, getStagehandRegistryDir } from "../config/env.mjs";
import { validateStagehandCache } from "../stagehand-lab/cache.mjs";
import { validateCfdiXmlText } from "../stagehand-lab/cfdi-validator.mjs";
import { buildPintureriasStagehandFixture } from "../stagehand-lab/pinturerias-fixture.mjs";
import { validateStagehandPortalState } from "../stagehand-lab/registry.mjs";
import { runStagehandLab, runStagehandIfUseful } from "../stagehand-lab/stagehand-runner.mjs";

const errors = [];

if (typeof runStagehandLab !== "function" || typeof runStagehandIfUseful !== "function") {
  errors.push("Stagehand runner exports are missing");
}

const fixture = await buildPintureriasStagehandFixture();

if (fixture.extracted.rfcEmisor !== "PMA1805167L1") {
  errors.push("Pinturerias fixture RFC mismatch");
}

await validateJsonDirectory({
  dir: getStagehandRegistryDir(),
  label: "registry",
  validate: validateStagehandPortalState,
  errors,
});
await validateJsonDirectory({
  dir: getStagehandCacheDir(),
  label: "cache",
  validate: validateStagehandCache,
  errors,
});

const sampleCfdi = validateCfdiXmlText({
  xml: `<cfdi:Comprobante Total="99.50" Fecha="2026-05-15T09:51:14"><cfdi:Emisor Rfc="PMA1805167L1"/><cfdi:Receptor Rfc="XAXX010101000"/><cfdi:Complemento><tfd:TimbreFiscalDigital UUID="11111111-1111-4111-8111-111111111111"/></cfdi:Complemento></cfdi:Comprobante>`,
  expected: {
    rfcEmisor: "PMA1805167L1",
    rfcReceptor: "XAXX010101000",
    monto: 99.5,
    fecha: "2026-05-15",
  },
});

if (!sampleCfdi.ok) {
  errors.push(`CFDI validator sample failed: ${sampleCfdi.errors.join("; ")}`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Stagehand lab validation passed.");
}

async function validateJsonDirectory({ dir, label, validate, errors }) {
  const absoluteDir = resolve(dir);
  const files = await readdir(absoluteDir).catch((error) => {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  });

  for (const file of files.filter((item) => item.endsWith(".json"))) {
    try {
      const value = JSON.parse(await readFile(join(absoluteDir, file), "utf8"));
      validate(value);
    } catch (error) {
      errors.push(`${label}/${file}: ${error.message}`);
    }
  }
}
