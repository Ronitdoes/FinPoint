# Runbook: WorkflowFailureRate (page)

**Alert:** `WorkflowFailureRate` — terminal `FAILED` outcomes >1% of starts over 15m.
**Severity:** page · **Owner:** Platform on-call (primary) · Temporal/Workflows owner (secondary).
**Dashboards:** [Operations](../../infra/grafana/dashboards/operations.json) (starts vs outcomes), [Temporal UI](http://localhost:8080) (`revenue-recovery` namespace).
**Logs:** [`docs/LOGGING.md`](../LOGGING.md) query D filtered to `workflow_id`.

## Symptoms

- Recovery journeys dying terminally; SLO 2 (journey success ≥99% weekly) burning.
- Possibly paired with `TemporalWorkerPollers` (halted) or `ProviderFailureRate` (downstream cause).

## Diagnosis

1. Split: `sum by (type, result) (rate(workflow_outcome_total[15m]))` — which workflow (A/B/C) and which terminal result?
2. Open the failed runs in Temporal UI (`recover:{caseId}` workflow ids): read the failure payload — activity error code tells the layer (VALIDATION_FAILED / POLICY_REJECTED / TERMINAL_DECLINE / provider 5xx / timeout).
3. Check worker health FIRST: if `temporal_worker_pollers == 0`, follow `temporal-worker-pollers.md` — failures are a symptom, not the cause.
4. Check blast radius: single tenant (bad tenant data/rule) vs all tenants (bad deploy/bad provider). `GET /cases/:id/timeline` for one failed case shows the exact step that terminally failed.

## Mitigation

- Worker/poller cause ⇒ fix there; workflows resume from history (durable execution — do NOT restart workflows manually unless the runbook for that workflow type says so).
- Provider cause ⇒ follow `provider-failure-rate.md`; failed runs already recorded outcomes — verify no double-charge via idempotency keys (`tenant:case:RETRY_PAYMENT:attempt`).
- Bad deploy ⇒ rollback per `docs/deploy/rollback.md` (forward-only, N/N+1); failed cases stay failed — assess whether re-drive via `/events/replay` is appropriate per case.

## Escalation

- >5% failure or any suspected double-charge ⇒ SEV-1, page Backend lead + Finance on-call; freeze retries until the idempotency audit (query E in LOGGING.md) is clean.

*Lifecycle: firing → acknowledged → mitigated → postmortem-link (required for every page).*
