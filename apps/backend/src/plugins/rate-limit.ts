import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import fastifyRateLimit, { type RateLimitPluginOptions } from "@fastify/rate-limit";
import type Redis from "ioredis";

export interface AppRateLimitOptions {
  redis?: Redis | null;
  max?: number;
  timeWindow?: string | number;
  allowList?: string[];
  skipOnError?: boolean;
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

  if (opts.redis) {
    rateLimitOptions.redis = opts.redis;
  }

  await fastify.register(fastifyRateLimit, rateLimitOptions);
};

export const rateLimitPlugin = fp(rateLimitPluginCallback, {
  name: "app-rate-limit",
  fastify: "5.x",
});
