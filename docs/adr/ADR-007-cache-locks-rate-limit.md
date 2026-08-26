# ADR-007 — Cache, locks, and rate limiting: Redis

- **Status:** Accepted
- **Date:** 2026-08-25
- **Deciders:** Engineering (step s-01)
- **Related specs:** `specs/01-implementation-0-to-100.md` §3, §21

## Context

The gateway needs idempotency checks (spec 01 §7), hot-path rate limiting (spec 01 §22), and distributed locks for cross-instance coordination. Redis is already listed in the MVP stack and `.env.example`.

## Decision

1. Redis is used exclusively for cache, distributed locks, idempotency short-circuits, and rate limiting.
2. Redis is **never** the source of truth: any state whose loss would be unacceptable must live in PostgreSQL; Redis entries are advisory or reconstructable.
3. All keys are namespaced (`rr:{tenant|global}:{purpose}:…`) with explicit TTLs; no unbounded key growth.
4. Failure of Redis degrades to "slower/safe" behavior (e.g., fall through to DB idempotency checks) rather than request failure — verified in chaos tests (s-31).

## Consequences

- Idempotency has a fast path (Redis SETNX) backed by a durable path (unique constraint on stored events, spec 01 §7).
- Rate limiting is cluster-consistent rather than per-process.

## Alternatives considered

- **In-memory rate limits/locks:** rejected; API may run multi-instance and correctness of financial dedupe cannot be per-process.
