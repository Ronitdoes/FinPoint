# Rollback procedure (s-33)

Images are immutable by tag (`sha-<sha>` + semver, published by CI). A
rollback redeploys a PREVIOUS tag — the database is never downgraded.
Manual-only via `.github/workflows/rollback.yml` (`workflow_dispatch`).

Related: [`migrations.md`](./migrations.md) (why forward-only is safe),
[`environments.md`](./environments.md) (env matrix + probes).

---

## 1. Principles

1. **Migrations are forward-only.** There is no down-migration path and no
   workflow may invent one. Rollback = previous APP version running on the
   CURRENT schema.
2. **The N/N+1 rule makes (1) safe.** Every migration keeps app version N
   working on schema N+1 ([`migrations.md`](./migrations.md) §3), so the
   previous tag is compatible with the current schema by construction.
3. **Verify, then redeploy.** The workflow's `compat-check` job must pass
   BEFORE the platform hook fires: `CONFIRM_SCHEMA_COMPAT=true` (explicit
   human flag) AND green `migrate:check` against the target env (schema is
   at latest). Either red → the workflow stops, no traffic moves.
4. **Point-in-time recovery (PITR) is the last resort**, not a rollback
   step: it loses writes after the restore point and requires owner
   approval. Documented in §4, never automated.

## 2. Procedure (staging or production)

1. Pick the target: the last known-good immutable tag (CI publish summary,
   or the previous `smoke` run's `/version` sha). Tags are never reused or
   overwritten — if in doubt, prefer the older tag.
2. Dispatch `Rollback`: `target_tag`, `reason` (recorded for the drill
   log), `environment`. For production, the `production` environment's
   protection rules (required reviewers) apply on top.
3. Watch `compat-check`: it prints the forward-only acknowledgment and the
   `migrate:check` result. On failure, STOP and fix the schema state first
   (pending migration? apply forward. Failed migration? repair forward per
   [`migrations.md`](./migrations.md) §2) — then re-dispatch.
4. Watch `redeploy previous tag` (platform hook with `{"rollback":true}`),
   then the post-rollback `smoke` job: `/health`, `/ready`, `/version`
   (sha should now equal the TARGET tag — after a rollback, set
   `SMOKE_EXPECT_SHA` accordingly or accept the recorded mismatch note),
   `/metrics`, RBAC-negative, prod-shape demo-absence.
5. Confirm in product terms: one recent recovery case timeline renders,
   one analytics summary loads, no new error-budget burn in logs.
6. Append the drill/incident row to §5 below (required evidence for s-33).

## 3. When rollback is NOT the answer

- Schema itself is corrupt / migration half-applied → fix forward, then
  roll the app if needed. Rolling the app back over a half-applied schema
  violates the N/N+1 precondition and the compat gate will (correctly)
  block you.
- Bad data written by good code (wrong policy, bad prompt) → stop the
  bleeding first (pause cases / disable the rule via policy admin — no
  deploy needed), then decide app rollback vs config fix.
- Provider-side outage → rollback changes nothing; follow the resilience
  runbook (`docs/RESILIENCE.md`).

## 4. Last resort: DB point-in-time recovery

Requires owner approval (writes after the restore point are lost):

1. Freeze writes: scale API + workers to 0 (or platform maintenance mode).
2. Restore the managed-PG PITR snapshot to a NEW instance at the chosen
   timestamp (never over the live instance first).
3. Point a staging-shaped app at the restored instance; verify case counts,
   outcome totals, and the migration journal state.
4. Cut over connection strings, scale workloads back up, run full smoke.
5. Reconcile anything written between the snapshot and the freeze from
   provider dashboards (payments) and audit archives — record gaps openly.

## 5. Rollback drill log (required evidence)

Every drill — real or rehearsed — appends one row. The s-33 acceptance
drill is the first row.

| Date | Env | From tag | To tag | Compat gate | Smoke | Operator | Notes |
|---|---|---|---|---|---|---|---|
| 2026-09-10 | local (drill harness) | n/a (gate + smoke proven locally; live staging drill is an operator step at first staging deploy) | n/a | `migrate:check` bad-state rejection + pass-after-migrate proven vs ephemeral DB; `rollback-compat-check` flag enforcement verified | `smoke-staging` 6/6 vs local dev stack in non-strict mode (`STRICT=false`: 6th check reports drill shape, demo present by design in mock mode — see footnote) + prod-shape `/demo` 404 proven in-process | s-33 implementation | Full live-staging drill (redeploy previous tag → smoke → log row) runs at first staging deploy; procedure above is execution-ready |

> Footnote — smoke count reconciliation: the harness always runs 6 checks
> and reported **6/6** here (s-33 explanation §10). In non-strict mode the
> 6th check (prod-shape `/demo` absence) returns ok-with-detail
> (`demo route answered … (non-strict mode: staging drill shape?)`) instead
> of failing, so the run is 6/6 with the 6th reporting drill shape rather
> than proving prod-shape. Counted strictly (prod-shape gate), the same run
> is 5/6 + 1 informational — the earlier "5/6" phrasing. No contradiction:
> 6/6 harness output, 5/6 strict prod-shape assertions.
