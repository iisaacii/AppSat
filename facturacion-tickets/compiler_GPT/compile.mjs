import { compileAndSaveB3Candidate } from "./lib/compile-save.mjs";

const args = parseArgs(process.argv.slice(2));
const candidatePath = args.candidate;

if (!candidatePath) {
  throw new Error("Missing --candidate=path/to/b3.candidate.json");
}

const result = await compileAndSaveB3Candidate({
  candidatePath,
  historyPath: args.history,
  out: args.out,
  outDir: args["out-dir"],
  dryRun: args["dry-run"] === "true",
  options: args,
});

console.log(JSON.stringify({ outputPath: result.outputPath, ...result.summary }, null, 2));

function parseArgs(argv) {
  const parsed = {};

  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      continue;
    }

    const [key, ...valueParts] = arg.slice(2).split("=");
    parsed[key] = valueParts.length ? valueParts.join("=") : "true";
  }

  return parsed;
}
