import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import fastifyCors, { type FastifyCorsOptions } from "@fastify/cors";

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
  const isProd = opts.isProduction ?? process.env.NODE_ENV === "production";
  const envOrigins = process.env.CORS_ALLOWED_ORIGINS
    ? process.env.CORS_ALLOWED_ORIGINS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const allowedOrigins = new Set([
    ...DEFAULT_ORIGINS,
    ...envOrigins,
    ...(opts.allowedOrigins ?? []),
  ]);

  const corsOptions: FastifyCorsOptions = {
    origin: (origin, cb) => {
      // Allow requests with no origin (like mobile apps, curl, server-to-server)
      if (!origin) {
        return cb(null, true);
      }

      // Check if origin is explicitly allowed or matches local origin pattern
      if (
        allowedOrigins.has(origin) ||
        origin.startsWith("http://localhost:") ||
        origin.startsWith("http://127.0.0.1:")
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
