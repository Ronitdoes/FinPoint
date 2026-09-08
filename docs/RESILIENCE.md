# Resilience Evidence — Chaos & Concurrency Testing (Step 31)

Failure-testing program for Spec 01 §21 (fourteen scenarios). Hard invariant:
**financial actions must be idempotent**. Every scenario below is automated in
`tests/chaos/` and CI-runnable (`bun run test:chaos`); results were measured
against an isolated tenant per scenario with MOCK providers (no real money).

Harness: `tests/chaos/harness/` (`fault-points.ts`, `compose-admin.ts`,
`assert-invariants.ts`, `seed.ts`) plus the canonical registry in
`services/worker/src/framework/fault-points.ts`. How to run locally vs CI is
documented in [`tests/chaos/README.md`](../tests/chaos/README.md).

## Evidence table

| # | Spec 01 §21 scenario | Expected behavior | Actual measured result | Suite location |
|---|---|---|---|---|
| 1 | duplicate webhook | ×50 concurrent identical deliveries → 1 case/payment, N≥1 DUPLICATE, metrics consistent | 1 ACCEPTED + 49 DUPLICATE, 1 payment row, 1 event row, `webhook_deliveries_total{duplicate}` +49 / `{accepted}` +1 | `tests/chaos/scenarios/duplicate-webhook.chaos.test.ts` |
| 2 | out-of-order event | succeeded→failed→failed → final SUCCEEDED, regression counter +2 | Payment stayed SUCCEEDED; `event_order_regression_total` +2 | `tests/chaos/scenarios/out-of-order.chaos.test.ts` |
| 3 | Stripe timeout | Hang → attempt UNKNOWN → status poll converges, exactly one attempt | Sync outcome UNKNOWN → poll SUCCEEDED; 1 attempt row; `provider_calls_total` moved | `tests/chaos/scenarios/stripe-timeout.chaos.test.ts` |
| 4 | Razorpay timeout | Same contract, failure-side convergence | Sync UNKNOWN → poll FAILED (`do_not_honor` preserved); 1 attempt; action FAILED | `tests/chaos/scenarios/razorpay-timeout.chaos.test.ts` |
| 5 | WhatsApp timeout | Dispatch failure → single FAILED ledger row; retry sends exactly once | FAILED row once; same-key redelivery `isDuplicate` with 0 provider calls; fresh key SENT once | `tests/chaos/scenarios/whatsapp-timeout.chaos.test.ts` |
| 6 | LLM timeout | Hung model → client timeout wins → deterministic fallback, cost row present | FALLBACK_RULE_BASED + LLM cost entry; no partial decision row | `tests/chaos/scenarios/llm-timeout-malformed.chaos.test.ts` |
| 7 | LLM malformed response | Malformed ×3 storm → repair retry → fallback, never partial/bypass | 3/3 FALLBACK; INVALID_OUTPUT rows persisted; LLM costs ≥ decisions; `fallback_total` moved | `tests/chaos/scenarios/llm-timeout-malformed.chaos.test.ts` |
| 8 | Redis unavailable | Degraded-not-dead: traffic served, switches fall back, auto-recovery | `/health` 200 + `/events` 202 with null Redis; injections `source: fallback`; drill skipped w/o `CHAOS_INFRA` | `tests/chaos/scenarios/redis-down.chaos.test.ts` |
| 9 | Postgres reconnect | In-flight tx fails cleanly (retryable); pool reconnects; single-winner races | Bad statement rejected, next write served; concurrent guarded transitions elect exactly 1 winner | `tests/chaos/scenarios/postgres-reconnect.chaos.test.ts` |
| 10 | Temporal worker crash | SIGKILL after claim, before provider call → resume executes exactly once | Crashed run: 0 provider calls, EXECUTING + REQUESTED survive; resume: provider EXACTLY 1 call, 1 attempt, EXECUTED | `tests/chaos/scenarios/worker-crash.chaos.test.ts` |
| 11 | browser refresh | Same Idempotency-Key retry → same event id, one row | 2 sequential POSTs → same `eventId`, 1 event row | `tests/chaos/scenarios/refresh-network-retry.chaos.test.ts` |
| 12 | network retry | Concurrent retries → one row; losers get 409 IN_FLIGHT (retryable) | ×10 concurrent → 1 row; all 202s share one id; rest 409 | `tests/chaos/scenarios/refresh-network-retry.chaos.test.ts` |
| 13 | payment succeeds after workflow retry | STOPPED(MAX_RETRIES) + late success → attribution outcome, case stays STOPPED | `ATTRIBUTION_WINDOW` outcome recorded; case STOPPED; re-sweep no-op; `attribution_sweeper_matches_total` +1 | `tests/chaos/scenarios/late-success.chaos.test.ts` |
| 14 | customer opts out midway | Round-2 sends suppressed; workflow stops cleanly | Round 2 throws `CUSTOMER_OPTED_OUT` with 0 provider calls; ledger keeps 1 SENT row; case STOPPED(OPTED_OUT) | `tests/chaos/scenarios/optout-midway.chaos.test.ts` |

Backlog benchmark (Step 31 §Requirements 5): 5,000 mixed events enqueued
while the consumer is held → gate opens → full drain measured at **~0.6–0.9s**
with **zero loss and zero duplicates** (id-set equality), recorded on
`chaos_backlog_drain_duration_ms`; closed-bus publish fails fast per policy.
Suite: `tests/chaos/scenarios/backlog-drain.chaos.test.ts`.

## EXECUTING-stuck sweeper

`apps/backend/src/jobs/executing-sweeper.ts` (registered via
`apps/backend/src/jobs/index.ts`; enabled in non-test `server.ts` every
5 minutes; s-33 owns the durable schedule). Proven against induced stuck rows
in `worker-crash.chaos.test.ts`: a claimed action + REQUESTED attempt is
resolved via status query to EXECUTED with **zero provider charges**
(`executing_sweeper_actions_total{result=completed}` +1). The sweeper NEVER
blindly re-executes — only read-only `getPaymentStatus`/ledger reads plus
guarded `completeAction`/`failAction` writes.

## Infrastructure kill drills

Scripted in `tests/chaos/harness/compose-admin.ts` (`docker restart redis`,
30s Postgres pause, worker SIGKILL, Redpanda stop/start). They run under the
nightly compose profile (`CHAOS_INFRA=1`) and refuse prod-shaped envs; the
fast per-push subset proves the same degraded behaviors via fakes and asserts
`skipped` drill reports. JSON artifacts (`artifacts/chaos/`) attach to the CI
summary.

## Invariants (asserted by every scenario)

`assertInvariants(tenantId)` scans: payments↔attempts consistency (no shared
idempotency keys across SUCCEEDED attempts, terminal rows carry
`resolved_at`), message uniqueness by key, single live case per obligation,
outcomes ≤1/case, LLM cost entries for decided cases, and state-machine
vocabulary legality (chaos may not invent transitions).

## Metrics moved by the drills

`webhook_deliveries_total{duplicate,accepted}`, `event_order_regression_total`,
`provider_calls_total`, `provider_decline_total` (via execution paths),
`fallback_total`, `llm_calls_total{error}`, `attribution_sweeper_matches_total`,
`executing_sweeper_actions_total`, `chaos_faults_injected_total`,
`chaos_backlog_drain_duration_ms`, `bus_dlq_total` (consumer-engine paths
covered by s-11/s-22 suites).
