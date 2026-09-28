import {
  trace,
  type Tracer,
  type TracerProvider,
  context,
  propagation,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { SimpleSpanProcessor, BatchSpanProcessor, type SpanExporter, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";

export interface TracingOptions {
  serviceName?: string;
  otlpEndpoint?: string | null;
  isDev?: boolean;
  exporter?: SpanExporter;
  resourceAttributes?: Record<string, string>;
  forceReinit?: boolean;
}

let activeProvider: TracerProvider | null = null;
let isTracingInitialized = false;

/**
 * Initializes OpenTelemetry distributed tracing for the current process.
 * Idempotent: subsequent calls return the existing active tracer unless forceReinit is specified.
 *
 * Designed for Bun runtime compatibility with graceful error handling
 * so telemetry failures never crash application boot or request handlers.
 */
export function initTracing(options: TracingOptions = {}): Tracer {
  if (isTracingInitialized && activeProvider && !options.forceReinit) {
    return trace.getTracer(options.serviceName || "ai-revenue-recovery");
  }

  // NOTE: backend passes typed-config values via TracingOptions
  // (see apps/backend/src/plugins/otel.ts). The process.env reads below are an
  // optional standalone-library fallback only (tests / direct library use).
  // No secrets involved (OTLP endpoint URL + NODE_ENV only).
  const serviceName = options.serviceName || "ai-revenue-recovery";
  const otlpEndpoint = options.otlpEndpoint || process.env.OTEL_EXPORTER_OTLP_ENDPOINT || null;
  const isDev = options.isDev ?? (process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test");

  try {
    // 1. Configure W3C Trace Context propagation
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());

    // 2. Build resource attributes (OTel SDK 2.x: Resource class removed)
    const resource = resourceFromAttributes({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
      [SemanticResourceAttributes.SERVICE_VERSION]: "0.1.0",
      [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || "development",
      ...options.resourceAttributes,
    });

    // 3. Attach span processor / exporter (OTel SDK 2.x: no addSpanProcessor — pass via constructor)
    const spanProcessors: SpanProcessor[] = [];
    if (options.exporter) {
      // In-memory or custom exporter for testing
      spanProcessors.push(new SimpleSpanProcessor(options.exporter));
    } else if (otlpEndpoint) {
      const url = otlpEndpoint.endsWith("/v1/traces") ? otlpEndpoint : `${otlpEndpoint.replace(/\/$/, "")}/v1/traces`;
      const exporter = new OTLPTraceExporter({ url });
      spanProcessors.push(
        isDev ? new SimpleSpanProcessor(exporter) : new BatchSpanProcessor(exporter),
      );
    }

    const provider: NodeTracerProvider = new NodeTracerProvider({ resource, spanProcessors });

    // 4. Register globally (OTel SDK 2.x: register lives on NodeTracerProvider, not BasicTracerProvider)
    provider.register();
    trace.setGlobalTracerProvider(provider);

    activeProvider = provider;
    isTracingInitialized = true;

    return trace.getTracer(serviceName);
  } catch (err) {
    // Graceful fallback to default No-op tracer under Bun or minimal environments
    // Never crash the request path
    console.warn(
      `[observability] Failed to initialize OpenTelemetry tracing: ${err instanceof Error ? err.message : String(err)}. Falling back to No-op tracer.`,
    );
    return trace.getTracer(serviceName);
  }
}

/**
 * Returns the active OpenTelemetry tracer.
 */
export function getTracer(name = "ai-revenue-recovery", version = "0.1.0"): Tracer {
  return trace.getTracer(name, version);
}

/**
 * Flushes active spans and shuts down the tracer provider.
 */
export async function shutdownTracing(): Promise<void> {
  if (activeProvider && "shutdown" in activeProvider && typeof (activeProvider as any).shutdown === "function") {
    try {
      await (activeProvider as any).shutdown();
    } catch {
      // ignore teardown errors
    } finally {
      activeProvider = null;
      isTracingInitialized = false;
      trace.disable();
    }
  } else {
    activeProvider = null;
    isTracingInitialized = false;
    trace.disable();
  }
}

/**
 * Resets tracer state (primarily for test environments).
 */
export function resetTracing(): void {
  activeProvider = null;
  isTracingInitialized = false;
  trace.disable();
}

/**
 * Checks if OpenTelemetry tracing has been initialized.
 */
export function isTracingActive(): boolean {
  return isTracingInitialized;
}
