import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";

/**
 * Canonical per-route-class rate-limit policy (Step 30 §Requirements 4).
 *
 * Finalized policy table — enforced via `@fastify/rate-limit` route configs
 * (see `rate-limit.ts`) and, for auth, via the bespoke per-IP+email lockout
 * bucket in `modules/auth/service.ts` (stronger keying than the generic
 * plugin can express). Every row is asserted by
 * `tests/security/abuse-limits.integration.test.ts`.
 *
 * Keying: the plugin keys by caller identity — API-key hash when an
 * `Authorization` header is present, otherwise client IP. The auth login
 * bucket keys by IP+email-hash (5 attempts/min) so one user's lockout never
 * locks out other users behind the same NAT egress.
 */
export const RATE_LIMIT_POLICIES = {
  /** Inbound provider webhooks: high-throughput burst tolerant, per IP. */
  webhook: { max: 600, timeWindow: "1 minute" },
  /** Interactive login: 5 attempts/min per IP+email, then 429 lockout. */
  authLogin: { max: 5, timeWindow: "1 minute" },
  /** Authenticated reads: generous per-key budget for dashboard polling. */
  read: { max: 120, timeWindow: "1 minute" },
  /** Authenticated event ingestion: tight, abuse-sensitive surface. */
  events: { max: 60, timeWindow: "1 minute" },
  /** Live provider status polling: expensive fan-out, keep tight. */
  providerStatus: { max: 30, timeWindow: "1 minute" },
  /** Demo/simulation endpoints: non-prod only, abuse-prone by design. */
  demo: { max: 60, timeWindow: "1 minute" },
} as const;

export type RateLimitRouteClass = keyof typeof RATE_LIMIT_POLICIES;

/**
 * Route config fragment for a given policy class, spread into Fastify route
 * options as `config: { rateLimit: rateLimitFor("read") }`.
 */
export function rateLimitFor(routeClass: RateLimitRouteClass): {
  max: number;
  timeWindow: string;
} {
  const policy = RATE_LIMIT_POLICIES[routeClass];
  return { max: policy.max, timeWindow: policy.timeWindow };
}

/**
 * Caller-identity key generator for the global rate limiter.
 *
 * Prefers a truncated SHA-256 of the raw `Authorization` header (per-key
 * budgeting for machine clients and dashboard polling) and falls back to
 * the client IP for unauthenticated surfaces (webhooks, login). The raw
 * secret never leaves this function — only the 32-char hex digest is used
 * as the Redis/counter key, and it is never logged.
 */
export function rateLimitKeyGenerator(request: FastifyRequest): string {
  const authHeader = request.headers.authorization;
  if (typeof authHeader === "string" && authHeader.trim().length > 0) {
    const digest = createHash("sha256")
      .update(authHeader.trim())
      .digest("hex")
      .slice(0, 32);
    return `key:${digest}`;
  }
  const forwarded = request.headers["x-forwarded-for"];
  const ip =
    (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim() ||
    request.ip ||
    "unknown";
  return `ip:${ip}`;
}
