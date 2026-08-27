import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { SpanStatusCode, type Span } from "@opentelemetry/api";
import { initTracing, shutdownTracing, resetTracing } from "./tracing";
import { withSpan, withSpanSync, SpanAttributes } from "./span";

describe("Observability Tracing & Spans", () => {
  let memoryExporter: InMemorySpanExporter;

  beforeEach(() => {
    resetTracing();
    memoryExporter = new InMemorySpanExporter();
    initTracing({
      serviceName: "test-service",
      exporter: memoryExporter,
      forceReinit: true,
    });
  });

  afterEach(async () => {
    await shutdownTracing();
    memoryExporter.reset();
  });

  it("creates and records successful spans with attributes", async () => {
    const result = await withSpan(
      "test.operation",
      {
        [SpanAttributes.TENANT_ID]: "tenant-123",
        [SpanAttributes.CASE_ID]: "case-456",
        "custom.key": "custom.value",
      },
      async (span: Span) => {
        expect(span.isRecording()).toBe(true);
        return 42;
      },
    );

    expect(result).toBe(42);

    const spans = memoryExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span).toBeDefined();
    if (!span) return;

    expect(span.name).toBe("test.operation");
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes[SpanAttributes.TENANT_ID]).toBe("tenant-123");
    expect(span.attributes[SpanAttributes.CASE_ID]).toBe("case-456");
    expect(span.attributes["custom.key"]).toBe("custom.value");
  });

  it("records errors and exceptions when an async function throws", async () => {
    await expect(
      withSpan(
        "failing.operation",
        { [SpanAttributes.EVENT_ID]: "evt-999" },
        async () => {
          throw new Error("Simulated downstream failure");
        },
      ),
    ).rejects.toThrow("Simulated downstream failure");

    const spans = memoryExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span).toBeDefined();
    if (!span) return;

    expect(span.name).toBe("failing.operation");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe("Simulated downstream failure");
    expect(span.events).toHaveLength(1);
    expect(span.events[0]?.name).toBe("exception");
  });

  it("supports synchronous withSpanSync execution", () => {
    const value = withSpanSync(
      "sync.operation",
      { [SpanAttributes.ACTION_ID]: "act-101" },
      () => {
        return "synchronous_success";
      },
    );

    expect(value).toBe("synchronous_success");
    const spans = memoryExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span).toBeDefined();
    if (!span) return;

    expect(span.name).toBe("sync.operation");
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes[SpanAttributes.ACTION_ID]).toBe("act-101");
  });
});
