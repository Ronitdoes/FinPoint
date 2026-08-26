import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import fastifyCors, { type FastifyCorsOptions } from "@fastify/cors";

export interface CorsPluginOptions {
  allowedOrigins?: string[];
  isProduction?: boolean;
}

const DEFAULT_DEV_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
];

const corsPluginCallback: FastifyPluginAsync<CorsPluginOptions> = async (
  fastify,
  opts,
) => {
  const isProd = opts.isProduction ?? process.env.NODE_ENV === "production";
  const origins = opts.allowedOrigins && opts.allowedOrigins.length > 0
    ? opts.allowedOrigins
    : (isProd ? [] : DEFAULT_DEV_ORIGINS);

  const corsOptions: FastifyCorsOptions = {
    origin: (origin, cb) => {
      // Allow requests with no origin (like mobile apps, curl, server-to-server)
      if (!origin) {
        return cb(null, true);
      }

      if (!isProd) {
        // In development/test, allow localhost or explicitly specified dev origins
        if (origins.includes(origin) || origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) {
          return cb(null, true);
        }
      } else {
        // In production, enforce strict allowlist
        if (origins.includes(origin)) {
          return cb(null, true);
        }
      }

      return cb(new Error("Origin not allowed by CORS"), false);
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
    ],
    credentials: true,
  };

  await fastify.register(fastifyCors, corsOptions);
};

export const corsPlugin = fp(corsPluginCallback, {
  name: "app-cors",
  fastify: "5.x",
});
