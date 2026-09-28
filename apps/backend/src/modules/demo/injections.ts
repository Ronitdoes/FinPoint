import type Redis from "ioredis";
import type { DemoConfig } from "@repo/config";

export const DEMO_INJECTIONS_REDIS_KEY = "demo:injections";
export const DEMO_INJECTIONS_DEFAULT_TTL_SECONDS = 900; // 15 minutes

export interface DemoInjections {
  simulate_payment_timeout: boolean;
  simulate_message_failure: boolean;
  simulate_llm_failure: boolean;
  simulate_duplicate_webhook: boolean;
}

export const DEFAULT_INJECTIONS: DemoInjections = {
  simulate_payment_timeout: false,
  simulate_message_failure: false,
  simulate_llm_failure: false,
  simulate_duplicate_webhook: false,
};

/**
 * Resolves default fallback injections from typed configuration.
 *
 * CONVENTIONS §1: the only env source is `@repo/config` (`DemoConfig`,
 * validated fail-fast at boot with SIMULATE_* defaulting to false). When no
 * config is provided (unit tests, Redis-less paths), defaults are all false —
 * identical to the schema defaults. No raw `process.env` reads here; callers
 * pass `(app as any).config?.demo` / `config.demo` (see demo/routes.ts,
 * simulator.service.ts, ai/decide.service.ts).
 */
export function getFallbackInjections(config?: Partial<DemoConfig> | null): DemoInjections {
  return {
    simulate_payment_timeout: config?.simulatePaymentTimeout ?? false,
    simulate_message_failure: config?.simulateMessageFailure ?? false,
    simulate_llm_failure: config?.simulateLlmFailure ?? false,
    simulate_duplicate_webhook: config?.simulateDuplicateWebhook ?? false,
  };
}

/**
 * Reads demo injections with Redis read-through and env/config fallback.
 * If Redis contains key (within 15m TTL), uses Redis values; otherwise falls back.
 */
export async function getDemoInjections(
  redis?: Redis | null,
  fallbackConfig?: Partial<DemoConfig> | null,
): Promise<{ injections: DemoInjections; source: "redis" | "fallback"; ttlSeconds: number }> {
  const fallback = getFallbackInjections(fallbackConfig);

  if (!redis || redis.status !== "ready") {
    return {
      injections: fallback,
      source: "fallback",
      ttlSeconds: 0,
    };
  }

  try {
    const [raw, ttl] = await Promise.all([
      redis.get(DEMO_INJECTIONS_REDIS_KEY),
      redis.ttl(DEMO_INJECTIONS_REDIS_KEY),
    ]);

    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DemoInjections>;
      return {
        injections: {
          simulate_payment_timeout:
            typeof parsed.simulate_payment_timeout === "boolean"
              ? parsed.simulate_payment_timeout
              : fallback.simulate_payment_timeout,
          simulate_message_failure:
            typeof parsed.simulate_message_failure === "boolean"
              ? parsed.simulate_message_failure
              : fallback.simulate_message_failure,
          simulate_llm_failure:
            typeof parsed.simulate_llm_failure === "boolean"
              ? parsed.simulate_llm_failure
              : fallback.simulate_llm_failure,
          simulate_duplicate_webhook:
            typeof parsed.simulate_duplicate_webhook === "boolean"
              ? parsed.simulate_duplicate_webhook
              : fallback.simulate_duplicate_webhook,
        },
        source: "redis",
        ttlSeconds: ttl > 0 ? ttl : 0,
      };
    }
  } catch {
    // Redis read failed, seamlessly fall back
  }

  return {
    injections: fallback,
    source: "fallback",
    ttlSeconds: 0,
  };
}

/**
 * Stores or patches failure injection switches in Redis with 15-minute TTL.
 */
export async function setDemoInjections(
  redis: Redis | null | undefined,
  patch: Partial<DemoInjections>,
  fallbackConfig?: Partial<DemoConfig> | null,
  ttlSeconds: number = DEMO_INJECTIONS_DEFAULT_TTL_SECONDS,
): Promise<{ injections: DemoInjections; ttlSeconds: number }> {
  const current = await getDemoInjections(redis, fallbackConfig);
  const updated: DemoInjections = {
    simulate_payment_timeout:
      patch.simulate_payment_timeout ?? current.injections.simulate_payment_timeout,
    simulate_message_failure:
      patch.simulate_message_failure ?? current.injections.simulate_message_failure,
    simulate_llm_failure:
      patch.simulate_llm_failure ?? current.injections.simulate_llm_failure,
    simulate_duplicate_webhook:
      patch.simulate_duplicate_webhook ?? current.injections.simulate_duplicate_webhook,
  };

  if (redis && redis.status === "ready") {
    await redis.set(
      DEMO_INJECTIONS_REDIS_KEY,
      JSON.stringify(updated),
      "EX",
      ttlSeconds,
    );
  }

  return {
    injections: updated,
    ttlSeconds,
  };
}

/**
 * Clears demo injections from Redis.
 */
export async function clearDemoInjections(redis?: Redis | null): Promise<void> {
  if (redis && redis.status === "ready") {
    await redis.del(DEMO_INJECTIONS_REDIS_KEY);
  }
}
