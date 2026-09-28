# ADR-006 — Event streaming: Redpanda topic behind an EventBus interface with in-process fallback

- **Status:** Accepted
- **Date:** 2026-08-25
- **Deciders:** Engineering (step s-01)
- **Related specs:** `specs/01-implementation-0-to-100.md` §3 ("Keep Kafka/Redpanda optional in the earliest local prototype"), §6; `specs/03-mvp-build-spec.md` §1

## Context

Consumers (risk engine, context assembly, analytics) are decoupled from ingestion via asynchronous propagation (spec 02 §1). Spec 30 explicitly defers Kafka cluster complexity, yet milestone gate G2 requires the same consumer code to be proven under **both** bus drivers.

## Decision

1. All producers/consumers depend on an `EventBus` interface owned by `packages/domain` (envelope) / backend infra — never on a concrete broker client.
2. Two implementations exist:
   - `redpanda` — real driver producing to topic `revenue-events.v1` (single topic, event-type keyed partitioning), selected when `EVENT_BUS_DRIVER=redpanda`;
   - `inprocess` — in-process fallback (durable outbox table + loopback dispatch) selected when `EVENT_BUS_DRIVER=inprocess` (the default for the earliest prototype).
3. Selection is env-driven only; application code paths are identical either way.
4. Redpanda runs via Docker Compose when enabled (s-02); no managed broker dependency for MVP.

> Clarification (s-11): partitioning is tenant-keyed (`tenant_id` as message key) with dedicated retry/dlq topics alongside the main topic. The single-topic description above is the original decision; s-11 refines it without changing the interface contract.

## Consequences

- Demos and CI run with zero broker infrastructure while preserving publish/consume semantics.
- Gate G2 verifies webhook → dedupe → bus → consumer under both drivers before proceeding.
- The envelope (id, type, occurred_at, source, tenant_id, customer_id, entity_id, payload, correlation_id — spec 01 §6) is the stable contract; broker payloads are just serialized envelopes.

## Alternatives considered

- **Redpanda mandatory from day one:** rejected; violates spec 01 §3 guidance and slows earliest prototype.
- **Redis streams as fallback:** rejected; Redis is reserved for cache/locks/rate-limit (ADR-007) and lacks consumer-group durability guarantees we want for events.
