import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import fastifyRateLimit, { type RateLimitPluginOptions } from "@fastify/rate-limit";
import type Redis from "ioredis";

export interface AppRateLimitOptions {
  redis?: Redis | null;
  max?: number;
  timeWindow?: string | number;
  allowList?: string[];
  skipOnError?: boolean;
  keyGenerator?: (request: FastifyRequest) => string;
  onLimitExceeded?: (request: FastifyRequest, routeClass: string) => void;
}

/**
 * Maps a request URL to the s-30 canonical route class for rate-limit
 * observability (`security_ratelimit_hits_total{route_class}`).
 */
export function classifyRateLimitRoute(url: string): string {
  const path = (url || "").split("?")[0];
  if (path.startsWith("/webhooks/")) return "webhook";
  if (path.startsWith("/auth/login")) return "auth";
  if (path.startsWith("/events")) return "events";
  if (path.startsWith("/demo/")) return "demo";
  if (/^\/payments\/[^/]+\/status$/.test(path)) return "providerStatus";
  return "read";
}

const rateLimitPluginCallback: FastifyPluginAsync<AppRateLimitOptions> = async (
  fastify,
  opts,
) => {
  const rateLimitOptions: RateLimitPluginOptions = {
    global: true,
    max: opts.max ?? 1000,
    timeWindow: opts.timeWindow ?? "1 minute",
    nameSpace: "rr:global:ratelimit:",
    skipOnError: opts.skipOnError ?? true,
    allowList: opts.allowList,
    addHeaders: {
      "retry-after": true,
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
    },
    errorResponseBuilder: (req, context) => {
      try {
        const routeClass = classifyRateLimitRoute(req.url || req.raw?.url || "");
        if (opts.onLimitExceeded) {
          opts.onLimitExceeded(req as FastifyRequest, routeClass);
        }
      } catch {
        // metrics must never break the limiter
      }
      return {
        error: {
          code: "RATE_LIMITED",
          message: `Rate limit exceeded, retry in ${context.after}`,
          details: {
            after: context.after,
            max: context.max,
            ttl: context.ttl,
          },
        },
      };
    },
  };

  if (opts.keyGenerator) {
    rateLimitOptions.keyGenerator = opts.keyGenerator as RateLimitPluginOptions["keyGenerator"];
  }

  if (opts.redis) {
    rateLimitOptions.redis = opts.redis;
  }

  await fastify.register(fastifyRateLimit, rateLimitOptions);
};

export const rateLimitPlugin = fp(rateLimitPluginCallback, {
  name: "app-rate-limit",
  fastify: "5.x",
});
