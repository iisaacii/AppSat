import { bridgeB3CandidateToA, displayBridgeSummary } from "../b3-to-a/b3-to-a-bridge.mjs";

const args = parseArgs(process.argv.slice(2));

if (!args.candidate) {
  throw new Error("Missing --candidate=data/portal-template-candidates/<b3>.candidate.json");
}

const result = await bridgeB3CandidateToA({
  candidatePath: args.candidate,
  fixturePath: args.fixture ?? null,
  profilePath: args.profile ?? "data/tax-profiles/sample.json",
  historyPath: args.history ?? null,
  replay: args.replay === "true",
  replayCount: args["replay-count"] ?? 2,
  approveFinalSubmit: args["approve-final-submit"] === "true",
  dryRun: args["dry-run"] === "true",
  markReplay: args["mark-replay"] !== "false",
  outDir: args["out-dir"] ?? "data/portal-template-candidates",
});

console.log(JSON.stringify(args.full === "true" ? result : displayBridgeSummary(result), null, 2));

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
