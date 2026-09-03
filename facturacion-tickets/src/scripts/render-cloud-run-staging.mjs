import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateCloudRunManifests } from "../deployment/cloud-run-manifests.mjs";

const configPath = getArgument("config");
if (!configPath) {
  throw new Error(
    "Usage: npm run deployment:cloud-run:render -- --config=deployment/cloud-run/staging.config.json",
  );
}

const outputDir = resolve(
  getArgument("out") ?? "deployment/cloud-run/generated",
);
const config = JSON.parse(await readFile(resolve(configPath), "utf8"));
const generated = generateCloudRunManifests(config);

await mkdir(outputDir, { recursive: true });
for (const [fileName, content] of Object.entries(generated.manifests)) {
  await writeFile(resolve(outputDir, fileName), content, "utf8");
}

const plan = {
  ok: true,
  projectId: generated.config.projectId,
  region: generated.config.region,
  resources: generated.names,
  scaling: generated.scaling,
  files: Object.keys(generated.manifests),
  nextCommands: [
    `gcloud run services replace ${resolve(outputDir, "api-service.yaml")} --region=${generated.config.region} --project=${generated.config.projectId}`,
    ...Object.entries(generated.manifests)
      .filter(([fileName]) => fileName.endsWith("worker-pool.yaml"))
      .map(
        ([fileName]) =>
          `gcloud run worker-pools replace ${resolve(outputDir, fileName)} --project=${generated.config.projectId}`,
      ),
    ...Object.entries(generated.scaling).map(
      ([name, instances]) =>
        `gcloud run worker-pools update ${name} --instances=${instances} --region=${generated.config.region} --project=${generated.config.projectId}`,
    ),
  ],
};

await writeFile(
  resolve(outputDir, "deployment-plan.json"),
  `${JSON.stringify(plan, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify({ ...plan, outputDir }, null, 2));

function getArgument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
}
