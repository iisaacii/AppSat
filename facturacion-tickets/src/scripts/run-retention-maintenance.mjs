import { getEnv } from "../config/env.mjs";
import { runFirestoreRetentionMaintenance } from "../maintenance/firestore-retention.service.mjs";

const execute = process.argv.includes("--execute");
const summaryOnly = process.argv.includes("--summary");

if (execute && getEnv("RETENTION_EXECUTE_CONFIRM") !== "CONFIRMO ejecutar limpieza EasySat") {
  throw new Error(
    "Execution requires RETENTION_EXECUTE_CONFIRM=CONFIRMO ejecutar limpieza EasySat. Run without --execute for dry-run.",
  );
}

const result = await runFirestoreRetentionMaintenance({ execute });
console.log(JSON.stringify(summaryOnly ? summarize(result) : result, null, 2));

function summarize(result) {
  return {
    ok: result.ok,
    mode: result.mode,
    now: result.now,
    policy: result.policy,
    jobs: summarizeSection(result.jobs),
    commands: summarizeSection(result.commands),
    templateCandidates: summarizeSection(result.templateCandidates),
    storage: summarizeSection(result.storage),
  };
}

function summarizeSection(section) {
  return {
    inspected: section.inspected,
    candidates: section.candidates,
    executed: section.executed,
    batchSize: section.batchSize,
    truncated: section.truncated,
    actions: (section.entries ?? []).reduce((counts, entry) => {
      const action = entry.action ?? "unknown";
      counts[action] = (counts[action] ?? 0) + 1;
      return counts;
    }, {}),
  };
}
