import { closeBillingQueueClients, inspectBillingQueues } from "../queue/billing-queue.mjs";

try {
  const queues = await inspectBillingQueues();
  console.log(JSON.stringify({ ok: true, queues }, null, 2));
} finally {
  await closeBillingQueueClients();
}
