# ADR-014 — Observability Stack (OpenTelemetry Tracing, Prometheus Metrics, Pino Logging)

- **Status:** Accepted
- **Date:** 2026-08-27
- **Deciders:** Engineering (step s-08)
- **Related specs:** `specs/01-implementation-0-to-100.md` §20 (observability baseline), `specs/steps/s-08.md`

## Context

Spec 01 §20 mandates full-system observability: HTTP latency, workflow latency, LLM latency/tokens, provider latency/failures, policy rejections, and recovery outcomes — all correlated end-to-end by five core trace keys (`event_id`, `case_id`, `workflow_id`, `decision_id`, `action_id`).

The runtime is Bun ≥ 1.4 (ADR-001). Under Bun, some OpenTelemetry Node auto-instrumentation packages (such as `@opentelemetry/auto-instrumentations-node`) attempt deep monkey-patching of internal Node C++ bindings that may fail or behave inconsistently. Furthermore, local development and unit tests need fast, zero-dependency metric assertions without requiring an external collector container to be active.

## Decision

1. **Dual-Signal Architecture**:
   - **Metrics**: Standard `prom-client` registry exposed directly via `GET /metrics` on the backend. This enables scraping by Prometheus/Grafana without an external collector dependency during local development and testing.
   - **Distributed Tracing**: OpenTelemetry SDK (`@opentelemetry/sdk-trace-base`, `@opentelemetry/api`, OTLP exporter) exporting spans over OTLP HTTP (`:4318`) or gRPC (`:4317`) to `otel-collector`.
2. **Explicit Choke-Point Instrumentation (Bun Compatibility)**:
   - Rather than relying on fragile Node runtime monkey-patching, distributed tracing uses explicit, well-defined choke-point instrumentation:
     - Fastify plugin hooks (`onRequest`, `onResponse`, `onError`) for HTTP server spans.
     - `withSpan(name, attrs, fn)` wrapper for async business logic, database queries, and external provider adapters.
     - In-memory span exporter for unit and integration testing without external collectors.
3. **Correlation ID & Context Propagation**:
   - Inbound requests propagate W3C Trace Context (`traceparent`) and internal `x-correlation-id`.
   - Pino child loggers automatically bind `requestId`, `correlationId`, `tenant_id`, `case_id`, and active OTel `trace_id` / `span_id`.
4. **Standard Span Attributes**:
   - Defined centrally in `@repo/observability` (`SpanAttributes`) and documented in `CONVENTIONS.md`:
     `recovery.event_id`, `recovery.case_id`, `recovery.workflow_id`, `recovery.decision_id`, `recovery.action_id`, `tenant.id`, `llm.model`, `provider.name`, `provider.operation`.

## Consequences

- High stability: Telemetry failures never take down the request path or crash application boot under Bun.
- Fast tests: Unit and integration tests run entirely in-memory with zero network overhead.
- Telemetry baseline established for all subsequent roadmap steps (s-09 authn, s-10 webhooks, s-14 AI, s-16 policy, s-18/s-19 providers, s-20 workflows).

## Alternatives considered

- **OTel Metrics instead of prom-client**: Rejected for MVP; prom-client provides a battle-tested `/metrics` endpoint with zero collector setup overhead for local developer loops.
- **Node auto-instrumentations-node**: Rejected due to Bun runtime monkey-patching incompatibilities and unreliability.
