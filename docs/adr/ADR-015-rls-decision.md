# ADR-015 — Row-Level Security (RLS) evaluation: defer in favor of app-layer scoping

- **Status:** Accepted
- **Date:** 2026-09-06
- **Deciders:** Engineering (step s-30)
- **Related specs:** `specs/02-architecture-and-domain.md` §15; `specs/03-mvp-build-spec.md` §11; `specs/steps/s-30.md` §Requirements 1

## Context

Step s-30 requires an explicit decision: rely on application-layer tenant
scoping plus indexes at MVP, or enable PostgreSQL Row-Level Security
(`CREATE POLICY` per table, keyed on `current_setting('app.tenant_id')`) as
defense-in-depth on `recovery_cases`, `payments`, and `messages`.

Tenant isolation today is enforced in exactly one place per request path:

1. `getTenantScope(request)` resolves `tenantId` solely from the verified
   principal (session/API key) and throws `TENANT_CONTEXT_MISSING` otherwise
   (CONVENTIONS §15, ADR-012).
2. All 23 aggregate repositories take `tenantId` as a first-call parameter
   and scope every query by it (s-06), backed by per-tenant indexes (s-04/s-05).
3. The s-30 cross-tenant probe suite
   (`tests/security/cross-tenant.probe.test.ts`, 36 probes) asserts 404/empty
   for foreign ids across the full route inventory.

## Decision

**Defer RLS at MVP; stay with app-layer scoping + indexes.** Rationale:

1. **Connection pooling incompatibility.** Production connects through a
   pooler in transaction mode (ADR-003/ADR-004). `SET LOCAL app.tenant_id`
   is transaction-scoped and cannot survive checkout/checkin; statement-level
   `SET` leaks across checkouts and would *create* the cross-tenant bug RLS
   is meant to prevent. Doing RLS safely requires either session pinning
   (defeats pooling) or a `SET` on every transaction boundary in every
   repository — a larger, riskier change than the threat it mitigates now.
2. **Single database role.** All app traffic uses one pooled role; RLS
   policies only bite when the session variable is reliably set (see 1).
   The existing DB-level enforcement precedent is narrower and safer:
   append-only triggers on `audit_logs`/`case_events` (s-25), which need no
   session state.
3. **Verified coverage already exists.** The probe suite proves isolation at
   the HTTP boundary for every tenant-scoped endpoint; repository signatures
   make unscoped queries a compile-time shape error.

## Consequences

- No migration in s-30. New repositories must keep the tenant-first
  signature convention (CONVENTIONS §9); reviewers reject unscoped queries.
- Revisit when any of these become true: (a) direct multi-role DB access
  (analyst replicas, per-tenant roles), (b) session-pinned pooling, or
  (c) a second writer service with its own scoping bugs. The migration
  sketch below is the starting point.
- s-31 chaos tests must include a tenant-confusion injection (event with
  mismatched `tenant_id`) to keep proving the app layer.

## Migration sketch (deferred, not applied)

```sql
-- Per-table hardening if/when session context becomes reliable:
ALTER TABLE recovery_cases ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON recovery_cases
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- Repeat for payments, messages, and remaining tenant tables; add
-- FORCE ROW LEVEL SECURITY for table owners; set the variable in a
-- transaction-local wrapper inside withTransaction (packages/db).
```

## Alternatives considered

- **Enable RLS now on three tables:** rejected — without reliable session
  variables, policies either break pooling or silently permit everything
  (`current_setting(..., true)` returns NULL → comparisons fail closed and
  take down legitimate traffic, or an unset variable is worked around with
  permissive policies that add no safety).
- **Per-tenant database roles:** rejected for MVP — operational cost
  (migrations × roles, connection fan-out) far exceeds the marginal gain
  while a single backend service is the only writer.
