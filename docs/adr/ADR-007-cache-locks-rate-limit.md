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

> Amendment (2026-09-29) — prefix grandfathering (s-09/s-10/s-30 reality):
> Canonical for **new** keys remains `rr:{tenant|global}:{purpose}:…`. Grandfathered in-use prefixes — `apikey:${hash}` / `session:${hash}` (`plugins/auth.ts`, `modules/auth/service.ts`, 60s `EX`, hashed, fail-safe degrade-to-DB), `sec:ipblock:` (`modules/security/ip-block.service.ts`), `login_attempts:*` — stay until an opportunistic migration (dual-read + ACL + revocation-path update) because the security properties that matter (hashed values, short TTLs, advisory-only, degrade-to-DB safe per item 4) already hold; a rename buys hygiene at the cost of forced logouts. Redis ACLs must therefore allow `rr:*`, `apikey:*`, `session:*`, `sec:*`, `login_attempts:*` (see `runbooks/least-privilege-credentials.md`).
4. Failure of Redis degrades to "slower/safe" behavior (e.g., fall through to DB idempotency checks) rather than request failure — verified in chaos tests (s-31).

## Consequences

- Idempotency has a fast path (Redis SETNX) backed by a durable path (unique constraint on stored events, spec 01 §7).
- Rate limiting is cluster-consistent rather than per-process.

> Amendment (2026-09-29) — SETNX note: the shipped implementation enforces idempotency via the DB unique-constraint path (`events`, idempotency keys); no `SETNX` call exists in the tree. The Redis fast path remains a future optimization, not a current guarantee — do not cite it as a live control.

## Alternatives considered

- **In-memory rate limits/locks:** rejected; API may run multi-instance and correctness of financial dedupe cannot be per-process.
