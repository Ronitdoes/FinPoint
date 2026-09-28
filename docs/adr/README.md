# Architecture Decision Records — Index

Settled decisions. Binding on all implementation (see `docs/CONVENTIONS.md`).
Do not re-litigate in code review — open a superseding ADR instead.

| ADR | Title | Decides | Used by |
|---|---|---|---|
| [ADR-001](ADR-001-runtime.md) | Runtime | Bun ≥ 1.4; `bun install` only | every step |
| [ADR-002](ADR-002-http-framework.md) | HTTP framework | Fastify 5 on Bun (`buildApp` factory) | s-07…s-10 |
| [ADR-003](ADR-003-database.md) | Database | PostgreSQL 16 + Drizzle ORM (pooled `postgres.js`) | s-04–s-06 |
| [ADR-004](ADR-004-migrations.md) | Migrations | Forward-only Drizzle SQL, advisory lock, `--check` CI | s-06, s-33, s-35 |
| [ADR-005](ADR-005-workflow-engine.md) | Workflow engine | Temporal, namespace `revenue-recovery`, queue `recovery-main` | s-20, s-22–s-24 |
| [ADR-006](ADR-006-event-streaming.md) | Event streaming | Redpanda `revenue-events.v1` behind `EventBus` + in-process fallback | s-10, s-11, s-17 |
| [ADR-007](ADR-007-cache-locks-rate-limit.md) | Cache/locks/rate-limit | Redis 7 (`ioredis`): session/API-key hot-path cache, context/analytics cache, buckets, idempotency fast path | s-09, s-10, s-13, s-27 |
| [ADR-008](ADR-008-llm-access.md) | LLM access | OpenAI-compatible client, schema-enforced outputs, no tool-calling | s-14, s-15, CONVENTIONS §10 |
| [ADR-009](ADR-009-money-type.md) | Money type | Integer minor units + ISO-4217; never floats | s-03, s-04, s-26 |
| [ADR-010](ADR-010-identifiers.md) | Identifiers | UUIDv4 PKs, bigserial logs, `RC-{seq}` display-only | s-04, s-05 |
| [ADR-011](ADR-011-time-handling.md) | Time handling | UTC `timestamptz`, ISO-8601 APIs, tenant-TZ day math in utilities | s-04, s-24 |
| [ADR-012](ADR-012-authn-authz.md) | AuthN/Z | Sessions + API keys, 5 roles, mandatory tenant guard | s-09, s-21, s-30 |
| [ADR-013](ADR-013-test-runner.md) | Test runner | Vitest primary; `bun test` for pure domain units only | every test |
| [ADR-014](ADR-014-observability-stack.md) | Observability stack | OTel tracing + Prometheus + Pino | s-08, s-34 |
| [ADR-015](ADR-015-rls-decision.md) | RLS decision | Row-level security **deferred** with rationale + migration sketch | s-30 |
| [ADR-016](ADR-016-dashboard-data-pushgateway.md) | Dashboard data push | kpi-snapshot via Pushgateway (5m) for executive panels | s-34 |
| [design-frontend](design-frontend.md) | Frontend design note | Dashboard language/UX direction (advisory, not a numbered decision) | s-28 |
