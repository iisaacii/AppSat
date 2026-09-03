import { createServer } from "node:http";
import {
  getBillingApiAllowedOrigins,
  getBillingApiBodyLimitBytes,
  getBillingApiTicketLimitBytes,
  getBillingApiPort,
  getBillingApiRateLimitPerMinute,
  getBillingApiServiceTokenClientId,
  getBillingApiServiceTokenHash,
  shouldCheckRevokedFirebaseTokens,
} from "../config/env.mjs";
import { getFirebaseAuth } from "../config/firebase.mjs";
import { logger } from "../shared/logger.mjs";
import {
  closeBillingQueueClients,
  dispatchBillingCommandSignal,
  dispatchBillingJobSignal,
  isBillingQueueEnabled,
} from "../queue/billing-queue.mjs";
import { createBillingApiHandler, createMemoryRateLimiter } from "./billing-api-app.mjs";
import { createFirestoreBillingApiRepository } from "./billing-api-repository.mjs";
import { createBillingApiServiceTokenVerifier } from "./service-token-auth.mjs";
import { createFirebaseTicketUploadService } from "../storage/ticket-upload.service.mjs";

const port = getBillingApiPort();
const repository = createFirestoreBillingApiRepository();
const auth = getFirebaseAuth();
const ticketUpload = createFirebaseTicketUploadService();
const verifyServiceToken = createBillingApiServiceTokenVerifier({
  tokenHash: getBillingApiServiceTokenHash(),
  clientId: getBillingApiServiceTokenClientId(),
});
const handler = createBillingApiHandler({
  repository,
  verifyIdToken: (token) => auth.verifyIdToken(token, shouldCheckRevokedFirebaseTokens()),
  verifyServiceToken,
  allowedOrigins: getBillingApiAllowedOrigins(),
  bodyLimitBytes: getBillingApiBodyLimitBytes(),
  ticketLimitBytes: getBillingApiTicketLimitBytes(),
  ticketUpload,
  rateLimiter: createMemoryRateLimiter({ limit: getBillingApiRateLimitPerMinute() }),
  dispatchJobSignal: isBillingQueueEnabled() ? dispatchBillingJobSignal : null,
  dispatchCommandSignal: isBillingQueueEnabled() ? dispatchBillingCommandSignal : null,
  logger,
});
const server = createServer(handler);

server.requestTimeout = 60_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;

server.listen(port, "0.0.0.0", () => {
  logger.info("EasySat Billing API listening.", { port, version: "billing-http.v2" });
});

let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(signal));
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("EasySat Billing API shutting down.", { signal });
  server.close(async (error) => {
    await closeBillingQueueClients();
    if (error) {
      logger.error("EasySat Billing API shutdown failed.", { message: error.message });
      process.exitCode = 1;
    }
  });
}
