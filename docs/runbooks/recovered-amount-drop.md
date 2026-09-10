# Runbook: RecoveredAmountDrop (warn — silent pipeline break)

**Alert:** `RecoveredAmountDrop` — `kpi_revenue_recovered_minor` <50% of its trailing 7-day average for 30m.
**Severity:** warn · **Owner:** Revenue-Ops on-call (primary) · Platform on-call (secondary).
**Dashboards:** [Executive](../../infra/grafana/dashboards/executive.json) (recovered vs 7-day average, outcomes by method).
**Logs:** [`docs/LOGGING.md`](../LOGGING.md) query C across recent cases.

## Symptoms

- Money signal decaying with NO error alerts — the classic silent break (attribution sweeper stalled, outcome writer failing open, KPI snapshot stale, or genuinely fewer recoveries).

## Diagnosis (distinguish pipeline break from business reality)

1. Is the KPI pipeline alive? `time() - push_time_seconds{job="arr-kpi"}` — pushgateway series fresh (<10m)? If stale ⇒ kpi-snapshot job dead: check backend logs for `kpi-snapshot pass completed` and `PUSHGATEWAY_URL` reachability (see `monitoring-pipeline-down.md`).
2. Are outcomes still being recorded? `sum(rate(outcome_recorded_total[1h]))` by method — zero across methods ⇒ writer/attribution path broken (check AttributionSweeper + CostCompleteness cron logs, `docs/deploy/crons.md`).
3. Are cases still flowing? `sum(rate(case_funnel_total[1h]))` by stage — flow healthy but recoveries down ⇒ business reality (seasonality, provider success-rate dip — cross-check `ProviderFailureRate` and recent funnel conversion).
4. Audit the money: `GET /analytics/summary` vs Grafana — identical by construction (ADR-016); if they disagree, the snapshot job (not the API) is suspect.

## Mitigation

- Pipeline cause ⇒ fix the stalled job/sweeper; backfill is automatic on next pass (idempotent sweeps) — verify the KPI curve recovers before resolving.
- Business cause ⇒ no code action; notify Finance; record the observation in the ticket for the monthly SLO review.

## Escalation

- Drop to **zero** with live traffic ⇒ escalate to page (treat as `WorkflowFailureRate`-class incident).
- Suspected attribution double-count or money mismatch ⇒ freeze manual adjustments; page Finance on-call.

*Lifecycle: firing → acknowledged → mitigated → postmortem-link.*
