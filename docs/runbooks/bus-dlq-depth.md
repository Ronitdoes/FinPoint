# Runbook: BusDLQDepth (ticket+slack)

**Alert:** `BusDLQDepth` — `bus_dlq_depth > 0` sustained 15m OR any `bus_dlq_total` increase in 15m.
**Severity:** ticket+slack · **Owner:** Platform on-call.
**Dashboards:** [Operations](../../infra/grafana/dashboards/operations.json) (DLQ depth, consumer lag, outcomes by group/status).
**Logs:** [`docs/LOGGING.md`](../LOGGING.md) query B with the poison event's `correlation_id`.

## Symptoms

- Poison messages parked on `revenue-events.dlq`; affected consumer group shows `bus_consumed_total{status="dlq"|"poison"}` increasing while siblings stay green.

## Diagnosis (poison investigation — never purge blindly)

1. Identify the group and growth: `sum by (group) (increase(bus_dlq_total[15m]))`.
2. Read the DLQ record (Redpanda console `:8081` locally; staging console): `error.code`, `attempts`, `firstTopic`, `x-last-error` header. Classify:
   - `SCHEMA_VALIDATION_FAILED`/poison pill ⇒ malformed producer payload (check the most recent deploy of the publishing service).
   - `MAX_RETRIES_EXCEEDED` ⇒ downstream dependency down during the window (check provider/DB/Temporal timelines) — message itself is likely fine.
   - `NON_RETRYABLE_ERROR` (policy/validation/opt-out) ⇒ business rejection, usually correct behavior; confirm the rejection was intended.
3. Trace the original envelope: LOGGING.md query A with the DLQ record's `correlation_id`.

## Mitigation

- Fix the underlying cause first (deploy fix, restore dependency, correct producer schema).
- Replay deliberately: `POST /events/replay` (role ≥ OPERATIONS, audited) for the affected event ids only — never bulk-replay the whole DLQ.
- Confirm `bus_dlq_depth` returns to 0 and stays 0 for 30m; close the ticket with the replay ids.

## Escalation

- DLQ growing across ALL groups ⇒ bus substrate incident (Redpanda down): page Platform on-call immediately (treat as page).
- Poison from a provider schema change ⇒ notify Integrations owner + pin the normalizer `UNMAPPED` fallback review.

*Lifecycle: firing → acknowledged → mitigated (replay ids recorded) → postmortem-link.*
