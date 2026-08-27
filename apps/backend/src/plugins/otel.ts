import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import {
  initTracing,
  recordHttpRequest,
  isTracingActive,
  SpanAttributes,
  SpanStatusCode,
  type Tracer,
  type Span,
} from "@repo/observability";

declare module "fastify" {
  interface FastifyInstance {
    tracer: Tracer;
    isOtelActive: boolean;
  }
  interface FastifyRequest {
    span?: Span;
  }
}

export interface OtelPluginOptions {
  enabled?: boolean;
  serviceName?: string;
  otlpEndpoint?: string | null;
}

const otelPluginCallback: FastifyPluginAsync<OtelPluginOptions> = async (
  fastify,
  opts,
) => {
  const serviceName = opts.serviceName || "ai-revenue-recovery-backend";
  const otlpEndpoint = opts.otlpEndpoint ?? null;

  // Initialize tracing provider (idempotent)
  const tracer = initTracing({
    serviceName,
    otlpEndpoint,
  });

  fastify.decorate("tracer", tracer);
  fastify.decorate("isOtelActive", isTracingActive());
  fastify.decorateRequest("span", undefined);

  // Hook 1: onRequest — Start an active OpenTelemetry span
  fastify.addHook("onRequest", async (req: FastifyRequest) => {
    const route = req.routeOptions?.url || req.url;
    const spanName = `HTTP ${req.method} ${route}`;

    const span = tracer.startSpan(spanName, {
      attributes: {
        [SpanAttributes.HTTP_METHOD]: req.method,
        [SpanAttributes.HTTP_ROUTE]: route,
        "http.url": req.url,
        "http.request_id": req.requestId || "",
        "recovery.correlation_id": req.correlationId || "",
      },
    });

    req.span = span;
  });

  // Hook 2: onError — Record unhandled exceptions on span
  fastify.addHook("onError", async (req: FastifyRequest, _reply: FastifyReply, error: Error) => {
    if (req.span) {
      req.span.recordException(error);
      req.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message,
      });
    }
  });

  // Hook 3: onResponse — Complete span and record HTTP metrics
  fastify.addHook("onResponse", async (req: FastifyRequest, reply: FastifyReply) => {
    const startTime = (req as any)._startTime as number | undefined;
    const durationMs = startTime ? Math.round((performance.now() - startTime) * 100) / 100 : 0;
    const route = req.routeOptions?.url || req.url;

    // Record metrics in Prometheus registry
    recordHttpRequest(req.method, route, reply.statusCode, durationMs);

    // End span
    if (req.span) {
      req.span.setAttribute(SpanAttributes.HTTP_STATUS_CODE, reply.statusCode);

      if (reply.statusCode >= 500) {
        req.span.setStatus({
          code: SpanStatusCode.ERROR,
          message: `HTTP ${reply.statusCode}`,
        });
      } else {
        req.span.setStatus({ code: SpanStatusCode.OK });
      }

      req.span.end();
    }
  });
};

export const otelPlugin = fp(otelPluginCallback, {
  name: "app-otel",
  fastify: "5.x",
});
