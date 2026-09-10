# Firing Drill — paging-path evidence (s-34 §Tests)

Synthetic firing drill: force each top-3 page alert in staging and confirm
correct routing (page received + runbook link resolves). This file is the
procedure + evidence log.

## Scope

Top-3 page alerts (highest blast radius first):

| # | Alert | Force method (staging) | Expected routing |
|---|---|---|---|
| 1 | `TemporalWorkerPollers` | Scale worker deployment to 0 replicas for 6m (`kubectl scale deploy/worker --replicas=0` or platform equivalent) | page → staging paging drill target; runbook `temporal-worker-pollers.md` |
| 2 | `WebhookErrorRate` | Replay 50 invalid-signature deliveries at the staging webhook endpoint (forged `stripe-signature`, distinct external ids to avoid dedupe counting them as DUPLICATE) | page → drill target; runbook `webhook-error-rate.md` §3a |
| 3 | `WorkflowFailureRate` | Enable `SIMULATE_PAYMENT_TIMEOUT` + `SIMULATE_MESSAGE_FAILURE` injections (s-29 `/demo/injections`, 15m TTL) and drive one demo payment-fail scenario; provider storms push terminal failures over 1% | page → drill target; runbook `workflow-failure-rate.md` |

Also drill (warn path, slack only): `LLMFallbackRate` via `SIMULATE_LLM_FAILURE`
injection — confirm **no page** fires (warn routes to `#revenue-ops` only).

## Procedure per alert

1. Announce the drill in `#revenue-ops` (prevents a real SEV declaration).
2. Apply the force method; wait out the alert's `for:` duration + 2m.
3. Capture: Alertmanager UI screenshot (firing + receiver), drill-target receipt (webhook log line), and the resolved notification after rollback.
4. Roll back the force method; confirm resolution + 10m green.
5. Append the evidence row below with links (screenshots in the ticket; log excerpts inline).

## Safety rules

- Staging only — never against prod (prod drill needs its own change ticket).
- Each drill restores the exact prior state (replica counts, injection TTLs expire; verify `GET /demo/injections` empty afterwards).
- A drill that pages the real on-call rotation instead of the drill target is a drill FAILURE — fix routing before proceeding.

## Evidence log

| Date | Alert | Forced how | Page received (link) | Resolved (link) | Operator |
|---|---|---|---|---|---|
| _pending first staging deploy_ | `TemporalWorkerPollers` | — | — | — | — |
| _pending_ | `WebhookErrorRate` | — | — | — | — |
| _pending_ | `WorkflowFailureRate` | — | — | — | — |
| _pending_ | `LLMFallbackRate` (warn path) | — | — | — | — |

## Local executable equivalent (no staging needed)

`bun scripts/monitoring-check.mjs` asserts the drill's static preconditions
(alerts defined, thresholds match this repo's spec, every `runbook_url`
resolves to a reviewed file, dashboards reference only exported metrics);
the unit suite (`monitoring-s34.test.ts`) forces `TemporalWorkerPollers`,
`BusDLQDepth`, and `AuditWriteFailures` through the real gauge→expression
path with synthetic values. Both run in CI on every push.
