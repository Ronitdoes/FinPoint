# ADR-003 — Database: PostgreSQL on Neon + Drizzle ORM via pooled `postgres.js`

- **Status:** Accepted
- **Date:** 2026-08-25
- **Deciders:** Engineering (step s-01)
- **Related specs:** `specs/01-implementation-0-to-100.md` §3; `specs/02-architecture-and-domain.md` §1 ("PostgreSQL = source of truth"), §15

## Context

PostgreSQL is the single source of truth for financial state (spec 02 §1). The team has selected **Neon** (serverless Postgres, Lakebase-compatible) as the managed database platform. Neon fronts application traffic with a transaction-mode pooler that does not support prepared statements, so clients must connect with `prepare: false`. Migrations and DDL must use the unpooled direct endpoint instead (see ADR-004). `packages/db` already wires Drizzle ORM over `postgres.js` accordingly.

## Decision

1. **Neon PostgreSQL** is the system of record for all business entities, outcomes, and audit data.
2. Connections are configured per environment via two variables (both already in `.env.example`):
   - `DATABASE_URL` — Neon **pooled** hostname for application queries;
   - `DIRECT_URL` — Neon **direct** (unpooled) endpoint reserved for migrations/DDL.
   Local development uses either a local Postgres container (compose, s-02) or a Neon branch, exposed through the same variables — application code cannot tell the difference.
3. ORM is Drizzle ORM; schema definitions live in `packages/db/src/schema/`, repositories in `packages/db/src/repositories/` (built s-04…s-06).
4. Application queries use a pooled `postgres.js` client configured with `prepare: false` (`packages/db/src/client.ts`) for Neon pooler compatibility.
5. Invariants that must never be violated (money non-negative, status enums, unique idempotency keys) are enforced by PostgreSQL constraints first, not only application code (spec 01 §5).
6. Every business table carries `tenant_id` and queries scope by tenant (spec 02 §15).

## Consequences

- Type-safe query layer shared by API and worker through one package.
- Constraint violations surface as typed DB errors mapped to domain error codes.
- Neon scale-to-zero means first-query cold starts in idle environments; health checks and demo warm-up (s-29/s-35) must account for it.
- Neon branching gives cheap isolated databases for integration tests and migration verification from s-31 onward; branches are disposable and never carry production secrets beyond scoped roles.
- Row Level Security remains an optional future hardening (s-30), not required at MVP.

## Alternatives considered

- **MongoDB/document store:** rejected; relational integrity and transactional money math are core requirements here.
- **Self-managed Postgres (Railway/Render/Docker only):** kept as local-dev fallback via compose, but rejected as the primary platform; operational burden (backups, upgrades, pooling) buys nothing at MVP scale.
- **Supabase/other managed Postgres:** functionally viable, but Neon was selected for its pooler/branching model and existing `.env.example` wiring; switching later is cheap because no Neon-specific APIs are used in application code — only standard Postgres over `postgres.js`.

