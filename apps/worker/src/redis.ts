import { createClient } from "redis";
import { REDIS_URL, REDIS_WORKER_LEADER_KEY, REDIS_WORKER_LEASE_SEC } from "./config.js";

type OpenChannelRedisClient = ReturnType<typeof createClient>;

let redisClient: OpenChannelRedisClient | undefined;
let redisConnectPromise: Promise<OpenChannelRedisClient | undefined> | undefined;
let nextRetryAtMs = 0;
let warnedUnavailable = false;

function shouldUseRedis(): boolean {
  return Boolean(REDIS_URL);
}

async function getRedisClient(): Promise<OpenChannelRedisClient | undefined> {
  if (!shouldUseRedis()) {
    return undefined;
  }

  if (redisClient?.isReady) {
    return redisClient;
  }

  if (redisConnectPromise) {
    return redisConnectPromise;
  }

  if (Date.now() < nextRetryAtMs) {
    return undefined;
  }

  redisConnectPromise = (async () => {
    const client = createClient({ url: REDIS_URL });
    client.on("error", (error) => {
      if (!warnedUnavailable) {
        console.warn(`[worker] Redis error: ${error.message}`);
        warnedUnavailable = true;
      }
    });

    try {
      await client.connect();
      warnedUnavailable = false;
      redisClient = client;
      return redisClient;
    } catch (error) {
      if (!warnedUnavailable) {
        const message = error instanceof Error ? error.message : "Redis unavailable";
        console.warn(`[worker] Redis unavailable, continuing without leader lock (${message}).`);
        warnedUnavailable = true;
      }
      nextRetryAtMs = Date.now() + 5000;
      await client.disconnect().catch(() => undefined);
      return undefined;
    } finally {
      redisConnectPromise = undefined;
    }
  })();

  return redisConnectPromise;
}

export async function refreshLeadershipLease(workerId: string): Promise<boolean> {
  if (!shouldUseRedis()) {
    return true;
  }

  const client = await getRedisClient();
  if (!client) {
    return true;
  }

  try {
    const acquired = await client.set(REDIS_WORKER_LEADER_KEY, workerId, {
      NX: true,
      EX: REDIS_WORKER_LEASE_SEC
    });
    if (acquired === "OK") {
      return true;
    }

    const owner = await client.get(REDIS_WORKER_LEADER_KEY);
    if (owner !== workerId) {
      return false;
    }

    const renewed = await client.set(REDIS_WORKER_LEADER_KEY, workerId, {
      XX: true,
      EX: REDIS_WORKER_LEASE_SEC
    });
    return renewed === "OK";
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown redis error";
    console.warn(`[worker] Redis lease refresh failed, continuing in degraded mode (${message}).`);
    return true;
  }
}

export async function releaseLeadershipLease(workerId: string): Promise<void> {
  if (!shouldUseRedis()) {
    return;
  }

  const client = await getRedisClient();
  if (!client) {
    return;
  }

  try {
    const owner = await client.get(REDIS_WORKER_LEADER_KEY);
    if (owner === workerId) {
      await client.del(REDIS_WORKER_LEADER_KEY);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown redis error";
    console.warn(`[worker] Redis lease release failed (${message}).`);
  }
}

export async function closeRedis(): Promise<void> {
  const client = redisClient;
  redisClient = undefined;
  if (!client) {
    return;
  }

  await client.disconnect().catch(() => undefined);
}
