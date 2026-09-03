import { resetMockJobs } from "./jobs/mock-job-store.mjs";
import { seedDemoFirestoreJob } from "./jobs/firestore-job-store.mjs";
import { createJobStore } from "./jobs/job-store.mjs";
import { runFacturaJobWorkerOnce } from "./jobs/factura-job.worker.mjs";
import { closeRedisClient } from "./config/redis.mjs";
import { closeBillingQueueClients } from "./queue/billing-queue.mjs";
import { watchBillingJobTransport } from "./queue/billing-queue-runtime.mjs";
import { logger } from "./shared/logger.mjs";

const mode = process.argv.find((arg) => arg.startsWith("--") && !arg.startsWith("--store=")) ?? "--once";
const store = createJobStore();

if (mode === "--reset") {
  await resetMockJobs();
  logger.info("Mock jobs reset.");
  process.exit(0);
}

if (mode === "--seed-demo") {
  await seedDemoFirestoreJob();
  logger.info("Firestore demo job seeded.");
  process.exit(0);
}

if (mode === "--watch") {
  const shutdown = new AbortController();

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      logger.info("Factura worker shutdown requested; finishing active work.", { signal });
      shutdown.abort(signal);
    });
  }

  try {
    await watchBillingJobTransport(store, { signal: shutdown.signal });
  } finally {
    await closeBillingQueueClients();
    await closeRedisClient();
  }
  logger.info("Factura worker stopped.");
} else {
  try {
    const processed = await runFacturaJobWorkerOnce(store);
    logger.info(processed ? "Processed one job." : "No pending jobs.");
  } finally {
    await closeRedisClient();
  }
}
