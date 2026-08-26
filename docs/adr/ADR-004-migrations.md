# ADR-004 — Migrations: forward-only Drizzle Kit SQL applied via `migrate.ts`

- **Status:** Accepted
- **Date:** 2026-08-25
- **Deciders:** Engineering (step s-01)
- **Related specs:** repo pattern `packages/db/src/migrate.ts`; spec 01 §5

## Context

Schema changes must be repeatable from an empty database (milestone gate G1), safe against concurrent deploy-time runners, and compatible with Neon-style transaction poolers that break prepared statements during DDL.

## Decision

1. Schema evolution uses Drizzle Kit SQL migrations (generated into `packages/db/drizzle/`).
2. Application of migrations goes exclusively through `packages/db/src/migrate.ts`, executed with `bun run db:migrate` (or its Docker/CI equivalent).
3. Migrations connect using `DIRECT_URL` (unpooled), falling back to `DATABASE_URL`; the connection is single-connection (`max: 1`).
4. Migrations are **forward-only**. No down-migrations are maintained; rollback is restore-from-backup or a new forward migration.
5. Migration application is advisory-locked (Postgres advisory lock taken by the migrator in s-06) so two runners cannot apply concurrently.

## Consequences

- Transaction-pooler-safe DDL path; local dev and production share one mechanism.
- Forward-only discipline means destructive changes require explicit new migrations and data backfill steps — reviewed per step.
- Gate G1 ("migrations apply from empty DB") is verifiable with a single command.

## Alternatives considered

- **drizzle-kit push at runtime:** rejected; non-deterministic, unsuitable for CI/production parity.
- **Reversible up/down pairs:** rejected; doubles authoring cost and gives false confidence — restores are tested instead (s-30/s-31).
