import type Redis from "ioredis";
import { sha256 } from "../../lib/crypto";
import { getLogger } from "@repo/observability";

const logger = getLogger({ component: "analytics-cache" });

const inFlightMap = new Map<string, Promise<any>>();

export interface AnalyticsCacheOptions {
  ttlSeconds?: number;
}

/**
 * Computes a deterministic cache key for analytics requests.
 */
export function buildAnalyticsCacheKey(
  tenantId: string,
  endpoint: string,
  params: Record<string, unknown>,
): string {
  const sortedParams = Object.keys(params)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = params[key];
      return acc;
    }, {});
  const paramsHash = sha256(JSON.stringify(sortedParams)).slice(0, 16);
  return `analytics:${tenantId}:${endpoint}:${paramsHash}`;
}

/**
 * Fetches analytics data using Redis with a 30s TTL, single-flight stampede protection,
 * and seamless fallback when Redis is offline or degraded (Step 27 Requirement 4).
 */
export async function fetchWithAnalyticsCache<T>(
  redis: Redis | null | undefined,
  tenantId: string,
  endpoint: string,
  params: Record<string, unknown>,
  fetcher: () => Promise<T>,
  opts: AnalyticsCacheOptions = {},
): Promise<T> {
  const ttlSeconds = opts.ttlSeconds ?? 30;
  const cacheKey = buildAnalyticsCacheKey(tenantId, endpoint, params);

  // 1. Single-Flight Promise Coalescing (Stampede Guard)
  if (inFlightMap.has(cacheKey)) {
    return (await inFlightMap.get(cacheKey)!) as T;
  }

  // 2. Check Redis Cache
  if (redis && redis.status === "ready") {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as T;
      }
    } catch (err: any) {
      logger.warn({ err: err.message, cacheKey }, "Redis analytics cache read warning");
    }
  }

  // 3. Execute Fetcher with In-Flight Tracking
  const executionPromise = (async () => {
    try {
      const result = await fetcher();

      // Write to Redis (30s TTL)
      if (redis && redis.status === "ready") {
        try {
          await redis.set(cacheKey, JSON.stringify(result), "EX", ttlSeconds);
        } catch (writeErr: any) {
          logger.warn(
            { err: writeErr.message, cacheKey },
            "Redis analytics cache write warning",
          );
        }
      }

      return result;
    } finally {
      inFlightMap.delete(cacheKey);
    }
  })();

  inFlightMap.set(cacheKey, executionPromise);
  return await executionPromise;
}

/**
 * Explicitly invalidates all cached analytics payloads for a tenant (called on outcome recording).
 */
export async function invalidateAnalyticsCache(
  redis: Redis | null | undefined,
  tenantId: string,
): Promise<void> {
  const prefix = `analytics:${tenantId}:`;

  // Clear in-flight entries
  for (const key of inFlightMap.keys()) {
    if (key.startsWith(prefix)) {
      inFlightMap.delete(key);
    }
  }

  // Scan & delete keys in Redis
  if (redis && redis.status === "ready") {
    try {
      const stream = redis.scanStream({
        match: `${prefix}*`,
        count: 100,
      });

      const keysToDelete: string[] = [];

      for await (const keys of stream) {
        if (Array.isArray(keys) && keys.length > 0) {
          keysToDelete.push(...keys);
        }
      }

      if (keysToDelete.length > 0) {
        await redis.del(...keysToDelete);
        logger.info(
          { tenantId, count: keysToDelete.length },
          "Invalidated tenant analytics cache keys",
        );
      }
    } catch (err: any) {
      logger.warn({ err: err.message, tenantId }, "Failed to invalidate Redis analytics cache");
    }
  }
}
