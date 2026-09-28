import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import {
  initTracing,
  recordHttpRequest,
  isTracingActive,
  SpanAttributes,
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Tracer,
  type Span,
  type Context,
} from "@repo/observability";

declare module "fastify" {
  interface FastifyInstance {
    tracer: Tracer;
    isOtelActive: boolean;
  }
  interface FastifyRequest {
    span?: Span;
    otelContext?: Context;
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
  fastify.decorateRequest("otelContext", undefined);

  // Hook 1: onRequest — Extract inbound W3C context and start request span as active.
  // G-08-1: propagation.extract(traceparent/tracestate) + context.with(trace.setSpan())
  // wrapping the remainder (done() called inside the active context) so that
  // withSpan children and the Pino mixin (trace.getActiveSpan) see the request
  // span. Telemetry must never break the request: all failures fall through to done().
  fastify.addHook("onRequest", (req: FastifyRequest, _reply: FastifyReply, done) => {
    const route = req.routeOptions?.url || req.url;
    const spanName = `HTTP ${req.method} ${route}`;
    const attributes = {
      [SpanAttributes.HTTP_METHOD]: req.method,
      [SpanAttributes.HTTP_ROUTE]: route,
      "http.url": req.url,
      "http.request_id": req.requestId || "",
      "recovery.correlation_id": req.correlationId || "",
    };

    try {
      // Extract remote parent (traceparent + tracestate when present). When no
      // traceparent is present this yields the current (root) context, so the
      // span below becomes a new root — same behavior as before the fix.
      let parentCtx: Context;
      try {
        parentCtx = propagation.extract(context.active(), req.headers);
      } catch {
        parentCtx = context.active();
      }

      const span = tracer.startSpan(spanName, { attributes }, parentCtx);
      const ctx = trace.setSpan(parentCtx, span);
      req.span = span;
      req.otelContext = ctx;

      // Activate for the remainder of the request lifecycle. Fastify invokes
      // subsequent hooks/handlers from within done(), so async resources
      // created there inherit this ALS store (verified: withSpan children
      // parent to the request span and Pino mixin sees trace_id/span_id).
      context.with(ctx, () => done());
    } catch {
      // Telemetry-never-breaks-request: fall back to an unactivated root span.
      try {
        req.span = tracer.startSpan(spanName, { attributes });
      } catch {
        // ignore — request proceeds without a span
      }
      done();
    }
  });

  // Hook 2: onError — Record unhandled exceptions on span (inside its context)
  fastify.addHook("onError", async (req: FastifyRequest, _reply: FastifyReply, error: Error) => {
    if (!req.span) return;
    try {
      const record = () => {
        req.span!.recordException(error);
        req.span!.setStatus({
          code: SpanStatusCode.ERROR,
          message: error.message,
        });
      };
      if (req.otelContext) {
        context.with(req.otelContext, record);
      } else {
        record();
      }
    } catch {
      // telemetry must never break error handling
    }
  });

  // Hook 3: onResponse — Complete span and record HTTP metrics
  fastify.addHook("onResponse", async (req: FastifyRequest, reply: FastifyReply) => {
    const startTime = (req as any)._startTime as number | undefined;
    const durationMs = startTime ? Math.round((performance.now() - startTime) * 100) / 100 : 0;
    const route = req.routeOptions?.url || req.url;

    // Record metrics in Prometheus registry (never breaks response)
    try {
      recordHttpRequest(req.method, route, reply.statusCode, durationMs);
    } catch {
      // ignore metrics failures
    }

    // End span inside its context so logs/mixin during onResponse correlate,
    // then the context.with scope exits (restores the ambient context).
    if (req.span) {
      try {
        const finish = () => {
          req.span!.setAttribute(SpanAttributes.HTTP_STATUS_CODE, reply.statusCode);

          if (reply.statusCode >= 500) {
            req.span!.setStatus({
              code: SpanStatusCode.ERROR,
              message: `HTTP ${reply.statusCode}`,
            });
          } else {
            req.span!.setStatus({ code: SpanStatusCode.OK });
          }

          req.span!.end();
        };
        if (req.otelContext) {
          context.with(req.otelContext, finish);
        } else {
          finish();
        }
      } catch {
        // ignore span-end failures
      }
    }
  });
};

export const otelPlugin = fp(otelPluginCallback, {
  name: "app-otel",
  fastify: "5.x",
});
