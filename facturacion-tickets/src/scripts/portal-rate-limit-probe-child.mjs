import { closeRedisClient } from "../config/redis.mjs";
import { runWithPortalRateLimit } from "../portals/portal-rate-limiter.mjs";

const id = readArg("id") ?? `probe-${process.pid}`;
const key = readArg("key") ?? "probe-portal";
const holdMs = Math.max(1, Number(readArg("hold-ms") ?? 100));
const timeoutMs = Math.max(1000, Number(readArg("timeout-ms") ?? 10000));
let acquiredAt = null;
let releasedAt = null;

try {
  await runWithPortalRateLimit(
    {
      rateLimitKey: key,
      rateLimit: { concurrency: 1, perMinute: 100 },
    },
    async () => {
      acquiredAt = Date.now();
      console.log(`PROBE_ACQUIRED ${JSON.stringify({ id, acquiredAt })}`);
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      releasedAt = Date.now();
    },
    { timeoutMs },
  );

  console.log(`PROBE_RESULT ${JSON.stringify({ id, key, acquiredAt, releasedAt })}`);
} finally {
  await closeRedisClient();
}

function readArg(name) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}
