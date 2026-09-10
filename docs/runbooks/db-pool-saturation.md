# Runbook: DBPoolSaturation (warn)

**Alert:** `DBPoolSaturation` — `db_pool_saturation_ratio > 0.8` for 10m.
**Severity:** warn · **Owner:** Platform on-call.
**Dashboards:** [Infrastructure](../../infra/grafana/dashboards/infra.json) (used vs max, saturation), [Operations](../../infra/grafana/dashboards/operations.json) (webhook latency — first victim).
**Logs:** slow-query warnings (>200ms, s-06 hook) + `cron tick skipped` overlaps.

## Symptoms

- Pool >80% checked out; webhook p95 and read latency degrade first; at 100%, everything queues and `WorkflowFailureRate`/`P95WebhookLatency` follow.

## Diagnosis

1. Used vs max: is the pool small for the replica count (each API replica × pool size vs Postgres `max_connections`)? `db_pool_used` / `db_pool_max` per process.
2. Leaked transactions: look for checkout-abandoned transactions — long-running `idle in transaction` backends in `pg_stat_activity` (via postgres-exporter or direct query on the admin endpoint). Recent deploys touching services/repositories are prime suspects (CONVENTIONS §9: services own tx boundaries).
3. Slow queries holding connections: `db_query_duration_ms` by `(operation, table)` + slow-query log lines; missing-index sequential scans on hot tables (`recovery_cases`, `events`, `audit_logs`).
4. Cron overlap: attribution/cost/retention passes colliding (overlap-guard skips + warns — check job logs); a stuck pass can pin connections.

## Mitigation

- Kill the leak: restart the offending deployment only after identifying it (restart masks leaks — capture `pg_stat_activity` first).
- Immediate relief: raise pool max within the `max_connections` budget (config change, rolling restart); add the missing index via forward-only migration (`docs/deploy/migrations.md` — DDL over `DIRECT_URL`, never the pooler).
- Never raise pools past Postgres capacity — queueing at the app is observable; connection refusal at the DB is not.

## Escalation

- Saturation 100% sustained or write errors surfacing ⇒ page Backend lead; consider read-replica split for analytics reads (ADR-016 path).

*Lifecycle: firing → acknowledged → mitigated → postmortem-link.*
