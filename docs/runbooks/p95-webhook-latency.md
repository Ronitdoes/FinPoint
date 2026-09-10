# Runbook: P95WebhookLatency (warn)

**Alert:** `P95WebhookLatency` — `histogram_quantile(0.95, webhook_duration_ms_bucket)` >300ms over 15m.
**Severity:** warn · **Owner:** Platform on-call.
**Dashboards:** [Operations](../../infra/grafana/dashboards/operations.json) (webhook latency p50/p95).
**Logs:** [`docs/LOGGING.md`](../LOGGING.md) query C for slow traces.

## Symptoms

- Spec 03 §10 target breached (see [`docs/PERFORMANCE.md`](../PERFORMANCE.md) for the co-located baseline p95 ≈ 51ms — anything far above that with a co-located DB is app-side).
- No errors yet; early warning before `WebhookErrorRate` follows.

## Diagnosis

1. Split: `histogram_quantile(0.95, sum by (le, provider) (rate(webhook_duration_ms_bucket[15m])))` — one provider or all?
2. If all providers slow: check `db_query_duration_ms` (slow-query hook logs >200ms, s-06) and `db_pool_saturation_ratio` — pool exhaustion serializes ingest (see `db-pool-saturation.md`).
3. If one provider slow: check its normalizer path + Redis (dedupe fast-path); `redis_memory_ratio` and bus lag.
4. Rule out geography: cross-region DB RTT dominates ingest (control experiment in PERFORMANCE.md §3 — 924ms RTT ⇒ 2.6s p95). Confirm DB host region matches the environment before tuning code.

## Mitigation

- Pool pressure ⇒ follow `db-pool-saturation.md` (leaked tx, pool sizing).
- Slow queries ⇒ add/match the spec-mandated index (schema change = forward-only migration, `docs/deploy/migrations.md`).
- Sustained breach with no infra cause ⇒ profile `webhook.persist` span; split core upserts out of the request path only via a reviewed design (never skip the idempotency anchor).

## Escalation

- Breach >1h or p99 >2s ⇒ escalate to page (treat as `WebhookErrorRate` pre-incident); owner Backend lead.

*Lifecycle: firing → acknowledged → mitigated → postmortem-link (warns need a postmortem only on recurrence ≥3×/week).*
