# Runbook: MonitoringPipelineDown (page — monitoring the monitor)

**Alert:** `MonitoringPipelineDown` — a Prometheus scrape target (`arr-backend`, `pushgateway`, or Prometheus self-scrape) down 5m.
**Severity:** page · **Owner:** Platform on-call.
**Dashboards:** [Infrastructure](../../infra/grafana/dashboards/infra.json) (scrape-targets-down panel); Prometheus `/targets` page directly.

## Symptoms

- Blindness, not (necessarily) user impact: silence from any other alert is untrustworthy until this resolves. Note the inhibit rule — `MonitoringPipelineDown` suppresses `warn` noise so the page stays legible.

## Diagnosis

1. Which target? `up{job=~"arr-backend|pushgateway|prometheus"} == 0`.
   - `arr-backend == 0`: API down or `/metrics` broken — check backend health (`/health`, `/ready`); if the API is down this is a full outage page, not just monitoring (follow deploy/smoke runbooks after restore).
   - `pushgateway == 0`: pushgateway container down — Executive KPIs freeze (see `recovered-amount-drop.md` §1 for the staleness check); gauges on the API target stay live.
   - `prometheus == 0` (self-scrape): Prometheus itself down — all alerting blind; Alertmanager may still hold firing state but evaluates nothing new.
2. Distinguish target-down from network-partition: can Prometheus reach other targets in the same network? If everything is 0, suspect Prometheus/network, not N simultaneous target failures.
3. Check Alertmanager separately (`:9093/-/healthy`) — alert *delivery* failing while Prometheus is fine is the mirror-image blindness (no alert covers it yet; verify manually during this incident).

## Mitigation

- Restart the failed component (container/platform); confirm `up == 1` for 10m on all three jobs before resolving.
- Backfill nothing — counters resume; gauges re-emit on the next sampler tick (60s) and KPI snapshot (5m). Note the blind window in the ticket.

## Escalation

- Blind >30m, or `arr-backend == 0` with user-facing errors ⇒ SEV-1, Backend lead paged; postmortem must explain why meta-monitoring didn't catch it sooner.

*Lifecycle: firing → acknowledged → mitigated (blind window recorded) → postmortem-link (required).*
