import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { LoggerOptions } from "pino";
import {
  createLoggerConfig as createBaseLoggerConfig,
  REDACT_PATHS,
} from "@repo/observability";

export { REDACT_PATHS };

export function createLoggerConfig(logLevel: string = "info"): LoggerOptions {
  const baseConfig = createBaseLoggerConfig({ level: logLevel });

  return {
    ...baseConfig,
    serializers: {
      req(req) {
        return {
          method: req.method,
          url: req.url,
          path: req.routeOptions?.url || req.url,
          parameters: req.params,
          headers: {
            ...req.headers,
            authorization: req.headers?.authorization ? "[REDACTED]" : undefined,
            cookie: req.headers?.cookie ? "[REDACTED]" : undefined,
            "stripe-signature": req.headers?.["stripe-signature"] ? "[REDACTED]" : undefined,
            "x-razorpay-signature": req.headers?.["x-razorpay-signature"] ? "[REDACTED]" : undefined,
          },
        };
      },
    },
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
