import pino, { type Logger, type LoggerOptions } from "pino";
import { trace } from "@opentelemetry/api";

/**
 * Sensitive fields to redact per CONVENTIONS §7 & §12.
 */
export const REDACT_PATHS = [
  "req.headers.authorization",
  'req.headers["stripe-signature"]',
  'req.headers["x-razorpay-signature"]',
  "req.headers.cookie",
  "password",
  "*.password",
  "apiKey",
  "*.apiKey",
  "stripeSecretKey",
  "*.stripeSecretKey",
  "razorpayKeySecret",
  "*.razorpayKeySecret",
  "token",
  "*.token",
  "secret",
  "*.secret",
  "key",
  "*.key",
  "api_key",
  "*.api_key",
  "client_secret",
  "*.client_secret",
];

export interface LogBindings {
  tenant_id?: string;
  customer_id?: string;
  case_id?: string;
  event_id?: string;
  decision_id?: string;
  action_id?: string;
  workflow_id?: string;
  requestId?: string;
  correlationId?: string;
  [key: string]: unknown;
}

export interface LoggerConfigOptions {
  level?: string;
  pretty?: boolean;
}

/**
 * Creates a standard Pino logger configuration object with redaction
 * and OpenTelemetry trace context mixing.
 */
export function createLoggerConfig(options: LoggerConfigOptions = {}): LoggerOptions {
  const isDev = process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test";
  const level = options.level || process.env.LOG_LEVEL || "info";
  const usePretty = options.pretty ?? isDev;

  return {
    level,
    redact: {
      paths: REDACT_PATHS,
      censor: "[REDACTED]",
    },
    // Dynamically enrich log lines with active OpenTelemetry trace/span IDs
    mixin() {
      const activeSpan = trace.getActiveSpan();
      if (!activeSpan) {
        return {};
      }
      const spanContext = activeSpan.spanContext();
      if (!spanContext.traceId) {
        return {};
      }
      return {
        trace_id: spanContext.traceId,
        span_id: spanContext.spanId,
        trace_flags: spanContext.traceFlags,
      };
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
            authorization: req.headers?.authorization ? "[REDACTED]" : undefined,
            "stripe-signature": req.headers?.["stripe-signature"] ? "[REDACTED]" : undefined,
            "x-razorpay-signature": req.headers?.["x-razorpay-signature"] ? "[REDACTED]" : undefined,
          },
        };
      },
    },
    transport: usePretty
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

let rootLogger: Logger | null = null;

/**
 * Creates or retrieves the root Pino logger instance.
 */
export function getRootLogger(): Logger {
  if (!rootLogger) {
    rootLogger = pino(createLoggerConfig());
  }
  return rootLogger;
}

/**
 * Returns a logger instance bound with the provided domain context fields.
 */
export function getLogger(bindings?: LogBindings): Logger {
  const root = getRootLogger();
  return bindings ? root.child(bindings) : root;
}
