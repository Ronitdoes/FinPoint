import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { LoggerOptions } from "pino";

/**
 * Secret redaction paths per CONVENTIONS §7 & §12.
 */
export const REDACT_PATHS = [
  "req.headers.authorization",
  'req.headers["stripe-signature"]',
  'req.headers["x-razorpay-signature"]',
  "req.headers.cookie",
  "*.password",
  "*.apiKey",
  "*.stripeSecretKey",
  "*.razorpayKeySecret",
  "*.token",
  "*.secret",
];

export function createLoggerConfig(logLevel: string = "info"): LoggerOptions {
  const isDev = process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test";

  return {
    level: logLevel,
    redact: {
      paths: REDACT_PATHS,
      censor: "[REDACTED]",
    },
    serializers: {
      req(req) {
        return {
          method: req.method,
          url: req.url,
          path: req.routeOptions?.url || req.url,
          parameters: req.params,
          headers: {
            ...req.headers,
            authorization: req.headers.authorization ? "[REDACTED]" : undefined,
            "stripe-signature": req.headers["stripe-signature"] ? "[REDACTED]" : undefined,
            "x-razorpay-signature": req.headers["x-razorpay-signature"] ? "[REDACTED]" : undefined,
          },
        };
      },
    },
    transport: isDev
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            ignore: "pid,hostname",
            translateTime: "SYS:HH:MM:ss.l",
          },
        }
      : undefined,
  };
}

export interface LoggerPluginOptions {
  onDurationRecorded?: (metricName: string, durationMs: number, labels: Record<string, string>) => void;
}

const loggerPluginCallback: FastifyPluginAsync<LoggerPluginOptions> = async (
  fastify,
  opts,
) => {
  // Store start time on request
  fastify.addHook("onRequest", async (req) => {
    (req as any)._startTime = performance.now();
  });

  // onResponse: one line per request at INFO with method, url, status, durationMs
  fastify.addHook("onResponse", async (req, reply) => {
    const startTime = (req as any)._startTime as number | undefined;
    const durationMs = startTime ? Math.round((performance.now() - startTime) * 100) / 100 : 0;

    // Record metric hook (s-08 will wire Prometheus / OTEL here)
    if (opts.onDurationRecorded) {
      opts.onDurationRecorded("http_request_duration_ms", durationMs, {
        method: req.method,
        route: req.routeOptions?.url || req.url,
        status: String(reply.statusCode),
      });
    }

    req.log.info(
      {
        method: req.method,
        url: req.url,
        status: reply.statusCode,
        durationMs,
      },
      `${req.method} ${req.url} -> ${reply.statusCode} (${durationMs}ms)`,
    );
  });
};

export const loggerPlugin = fp(loggerPluginCallback, {
  name: "request-logger",
  fastify: "5.x",
});
