import { createClient } from "redis";
import { getRedisConnectTimeoutMs, getRedisUrl } from "./env.mjs";
import { logger } from "../shared/logger.mjs";

let clientPromise = null;
let activeClient = null;

export async function getRedisClient() {
  if (activeClient?.isReady) {
    return activeClient;
  }

  if (!clientPromise) {
    clientPromise = connectRedisClient();
  }

  try {
    return await clientPromise;
  } catch (error) {
    clientPromise = null;
    activeClient = null;
    throw error;
  }
}

export async function closeRedisClient() {
  const pending = clientPromise;
  clientPromise = null;

  let client = activeClient;
  activeClient = null;

  if (!client && pending) {
    client = await pending.catch(() => null);
  }

  if (!client?.isOpen) {
    return;
  }

  await client.close().catch((error) => {
    logger.warn("Redis client did not close cleanly.", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

async function connectRedisClient() {
  const client = createClient({
    url: getRedisUrl(),
    socket: {
      connectTimeout: getRedisConnectTimeoutMs(),
      reconnectStrategy(retries) {
        return retries >= 3 ? false : Math.min(100 * (2 ** retries), 1000);
      },
    },
  });

  client.on("error", (error) => {
    logger.warn("Redis client error.", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  await client.connect();
  activeClient = client;
  logger.info("Redis client connected.");
  return client;
}
