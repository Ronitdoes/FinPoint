import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import fastifyCors, { type FastifyCorsOptions } from "@fastify/cors";

/**
 * CORS allowlist (s-07 audit G-07-2; G-07-1 enforcement fix).
 *
 * Enforcement actually applied by the origin callback below:
 * - Non-production (`isProduction: false`, dev/test): explicitly allowed
 *   origins (`DEFAULT_ORIGINS` + `allowedOrigins` opt) pass, plus a
 *   DEV-ONLY wildcard for any `http://localhost:*` / `http://127.0.0.1:*`
 *   port (local frontend convenience). Requests with no `Origin` header
 *   (curl, mobile, server-to-server) are allowed.
 * - Production (`isProduction: true`): ONLY the injected `allowedOrigins`
 *   set (typed config `config.http.corsAllowedOrigins` + explicit opts)
 *   passes, plus no-origin requests. `DEFAULT_ORIGINS` and the localhost
 *   wildcard are NOT honored in production.
 * Unknown origins are safely rejected via `cb(null, false)` (no CORS
 * headers, no 500) rather than by throwing.
 * This plugin reads no `process.env` directly (CONVENTIONS §1); `app.ts`
 * injects `allowedOrigins` + `isProduction` from `@repo/config`.
 */

export interface CorsPluginOptions {
  allowedOrigins?: string[];
  isProduction?: boolean;
}

const DEFAULT_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
  "http://localhost:4000",
  "http://127.0.0.1:4000",
];

const corsPluginCallback: FastifyPluginAsync<CorsPluginOptions> = async (
  fastify,
  opts,
) => {
  const isProd = opts.isProduction ?? false;

  // G-07-1: DEFAULT_ORIGINS are dev/test convenience only — never trust them
  // in production. Prod allows exactly the injected allowlist.
  const allowedOrigins = new Set(
    isProd ? [...(opts.allowedOrigins ?? [])] : [...DEFAULT_ORIGINS, ...(opts.allowedOrigins ?? [])],
  );

  const corsOptions: FastifyCorsOptions = {
    origin: (origin, cb) => {
      // Allow requests with no origin (like mobile apps, curl, server-to-server)
      if (!origin) {
        return cb(null, true);
      }

      // Explicit allowlist always applies.
      if (allowedOrigins.has(origin)) {
        return cb(null, true);
      }

      // G-07-1: localhost wildcard is DEV-ONLY — gated on !isProd so a
      // production deployment with isProduction:true never accepts an
      // arbitrary localhost port.
      if (
        !isProd &&
        (origin.startsWith("http://localhost:") ||
          origin.startsWith("http://127.0.0.1:"))
      ) {
        return cb(null, true);
      }

      // Safe reject without throwing 500 server error
      return cb(null, false);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Correlation-ID",
      "X-Request-ID",
      "Stripe-Signature",
      "X-Razorpay-Signature",
      "X-Tenant-ID",
      "X-API-Key",
    ],
    exposedHeaders: [
      "X-Correlation-ID",
      "X-Request-ID",
      "Retry-After",
      "x-cost-data-redacted",
    ],
    credentials: true,
  };

  await fastify.register(fastifyCors, corsOptions);
};

export const corsPlugin = fp(corsPluginCallback, {
  name: "app-cors",
  fastify: "5.x",
});
