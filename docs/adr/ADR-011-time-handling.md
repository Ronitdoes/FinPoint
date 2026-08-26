# ADR-011 — Time: UTC `timestamptz` storage, ISO-8601 exposure, tenant-timezone day math

- **Status:** Accepted
- **Date:** 2026-08-25
- **Deciders:** Engineering (step s-01)

## Context

Workflows schedule timers days out; invoices have business-day due dates; analytics bucket recovery by day. Naive local-time handling causes DST bugs and double-counting.

## Decision

1. All timestamps are stored as PostgreSQL `timestamptz` in UTC. No `timestamp` (without tz), no epoch-millis columns.
2. APIs expose timestamps as ISO-8601 UTC strings (`2026-08-23T10:30:00Z`). Clients render in their own timezone.
3. Business-day arithmetic (invoice due dates, "days overdue", promise-to-pay deadlines) converts to the tenant's configured timezone only inside the calculation function that needs it, then stores results back as UTC instants.
4. Workflow durations/timers are expressed as relative intervals (e.g., wait 24h) anchored to decision time, not wall-clock times, unless policy explicitly demands a wall clock.

## Consequences

- Deterministic ordering, dedupe, and attribution windows regardless of deployment timezone.
- Tenant timezone becomes a tenant setting consumed by a single date-math utility in `@repo/domain` — no ad-hoc timezone logic elsewhere.

## Alternatives considered

- **Store local time + offset:** rejected; ambiguous under DST and provider clock skew.
