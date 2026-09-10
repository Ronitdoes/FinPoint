# Migration policy — execution, gating, compatibility (s-33)

Migrations are Drizzle forward-only journals (`packages/db/drizzle/`,
applied by `packages/db/src/migrate.ts`). There is no down-migration: the
database never moves backward. This document is the contract the pipeline
(`migrate:check` gate, pre-deploy job) and [`rollback.md`](./rollback.md)
both depend on.

---

## 1. Runner guarantees (already in code, s-06)

- **Advisory lock**: `runMigrations()` takes PostgreSQL advisory lock
  `724193` before touching the journal, so two releasers (CI + platform
  hook, or two replicas racing at boot) serialize instead of double-applying.
- **Transient retry**: serialization/deadlock failures retry with backoff;
  any other failure aborts loudly with the migration name.
- **Direct connection**: DDL runs over `DIRECT_URL` (falling back to
  `DATABASE_URL` only when unset) with `max: 1` connection — poolers
  (PgBouncer/Supavisor in transaction mode) MUST be bypassed for DDL, hence
  staging/prod set a separate direct `DIRECT_URL` ([`environments.md`](./environments.md)).
- **Gate**: `bun run db:migrate:check` compares journal entries vs
  `drizzle.__drizzle_migrations` and exits non-zero when behind. CI proves
  the gate both ways on every run: it must FAIL on an empty database
  (bad-state rejection evidence) and PASS after `db:migrate`.

## 2. Pre-deploy execution (staging/prod)

```text
publish (immutable tag) → migrate job (DIRECT_URL) → app roll → smoke
```

- The `migrate` job in `.github/workflows/deploy-staging.yml` runs
  `db:migrate` then `db:migrate:check` against the target env BEFORE the
  platform redeploys the app. The same image can run it anywhere:
  `docker run … arr-backend:<tag> migrate` (see
  `infra/docker/backend-entrypoint.sh`).
- Never run migrations from a replica's boot path in staging/prod (no
  init-container migrations): exactly one actor holds the advisory lock per
  deploy, and its success/failure is visible as its own pipeline job.
- Migration failure blocks the deploy. Fix forward (new migration), never by
  hand-editing the target DB — hand edits desync the journal count and trip
  `migrate:check` on every later deploy.

## 3. Compatibility contract (the N / N+1 rule)

Rolling deploys briefly run **old and new app versions against one schema**,
so every migration must keep app version N working on schema N+1:

1. **Expand → contract for breaking changes.** Step 1 (expand): add the new
   column/table as nullable or with a safe default; deploy app code that
   writes both shapes and reads the old one. Step 2 (contract, a LATER
   deploy): backfill, flip reads, then drop the old shape. Renames are
   add-new + dual-write + drop-old, never `RENAME COLUMN` in one step.
2. **Additive changes are always safe**: new tables, new nullable columns,
   new indexes (use `CONCURRENTLY` semantics where the platform supports
   it), new enum values appended — never removed or reordered while old
   code runs.
3. **Constraints**: `NOT NULL` without a default, unique constraints over
   backfilled data, and check constraints ship only in the contract phase
   after the backfill deploy is live everywhere.
4. Review checklist for any migration PR: *does version N still boot, read,
   and write against this schema?* If the answer needs a qualifier, split
   the migration into expand/contract phases.

## 4. Rollback interaction

Because migrations are forward-only, rollback redeploys the previous APP
tag onto the CURRENT schema — which is exactly what the N/N+1 rule makes
safe. The rollback workflow verifies this with the compat gate
(`CONFIRM_SCHEMA_COMPAT=true` + green `migrate:check`) before redeploying.
Full procedure: [`rollback.md`](./rollback.md).
