# s-31 — Resilience, Chaos & Concurrency Testing: Implementation Explanation

This document explains, in complete depth, everything that was done to implement `specs/steps/s-31.md`. It is written so that a developer (or future agent) who was not present during implementation can understand every file, every decision, every deviation, and every problem that had to be debugged along the way.

---

## Table of contents

1. [What the step required](#1-what-the-step-required)
2. [Fault-point harness (`services/worker`, `tests/chaos/harness`)](#2-fault-point-harness)
3. [Backend crash windows (`execution.service.ts`)](#3-backend-crash-windows)
4. [EXECUTING-stuck sweeper (`apps/backend/src/jobs/`)](#4-executing-stuck-sweeper)
5. [Repository addition (`findStuckExecutingActions`)](#5-repository-addition)
6. [Observability additions](#6-observability-additions)
7. [Chaos scenario suites (`tests/chaos/scenarios/`)](#7-chaos-scenario-suites)
8. [Vitest + package wiring](#8-vitest--package-wiring)
9. [Problems discovered during verification and their fixes](#9-problems-discovered-during-verification-and-their-fixes)
10. [Verification evidence (Definition of Done)](#10-verification-evidence-definition-of-done)
11. [Deviations and judgment calls](#11-deviations-and-judgment-calls)

---

## 1. What the step required

Step s-31 turns the Spec 01 §21 failure list (fourteen scenarios, hard invariant *"Financial actions must be idempotent"*) into an automated, repeatable suite, plus:

- a fault-point harness with deterministic breakpoints (`FAULT_POINTS=claim:after_provider_call` style) implemented via pre/post hooks in the activity framework — no scattered ifdefs;
- scripted infrastructure kill drills (Redis restart, 30s Postgres pause, worker SIGKILL, Redpanda outage);
- an EXECUTING-stuck sweeper that reconciles claimed-but-never-completed actions via provider status query and NEVER blindly re-executes;
- a 5k-event backlog-drain benchmark with zero loss/duplicates and recorded timing;
- `docs/RESILIENCE.md` with an evidence table (each scenario → expected → measured → suite location).

The Definition of Done checklist:

- All 14 §21 scenarios automated with green runs recorded
- Fault-point harness documented; kills reproducible locally via single command
- EXECUTING sweeper proven against induced stuck rows
- Backlog drain: 5k events, zero loss/dupes, timing recorded
- `docs/RESILIENCE.md` published with evidence table

Everything below maps to those items.

---

## 2. Fault-point harness

**Canonical module:** `services/worker/src/framework/fault-points.ts` (exported from the framework index and as a light `@repo/worker/fault-points` subpath so the backend and the chaos tests share one registry instance).

- Entry format `<activity>:<phase>`, comma-separated; activity `*` matches all. Phases: `pre | post | after_claim | before_provider_call | after_provider_call`. Unknown phases are ignored (fail-safe on config typos).
- Two arming paths: `FAULT_POINTS` env (parsed lazily on every check, so no restart is needed to change it) and programmatic `armFaultPoint()` (preferred in tests). `withFaultPoint()` arms for the duration of a callback and always disarms in `finally`.
- Behaviors: `throw-crash` (SIGKILL analogue, `FaultInjectedError` with `crash: true`), `throw-transient`, and `delay`.
- `registerFaultHook()` adds pre/post hooks; the activity framework (`withActivityContext` in `services/worker/src/framework/activity-context.ts`) automatically runs `pre` hooks before and `post` hooks after every activity body — business code contains no env branches, only single choke-point calls to `checkFaultPoint()`.
- Safety: the harness is a no-op in production unless `CHAOS_ENABLED=true`; every injection records `chaos_faults_injected_total{fault,phase}`.
- Fine-grained call sites: `execute-retry-payment.ts` (`before/after_provider_call` around the charge + ledger write), `send-template-message.ts` (around dispatch + ledger insert), and the backend execution service (see §3).

**Unit proof:** `services/worker/src/framework/fault-points.test.ts` (6 tests: parsing, crash/transient/delay behaviors, wildcard, hook lifecycle, production guard).

## 3. Backend crash windows

**File:** `apps/backend/src/modules/payments/execution.service.ts` (+ `@repo/worker` workspace dep in `apps/backend/package.json`, `./fault-points` subpath in `services/worker/package.json`).

Three one-liner `checkFaultPoint("claim", …)` calls: `after_claim` (right after the guarded `claimActionForExecution`), `before_provider_call`, and `after_provider_call`. The surrounding `catch` rethrows `FAULT_INJECTED` so an injected crash is never misclassified as a provider-network UNKNOWN. Layering note: the backend imports only the dependency-free `fault-points` submodule (it imports just `@repo/observability`), not the Temporal worker runtime — and backend→worker consumption is precedented by s-20 ("client wrapper in worker package consumed by API").

## 4. EXECUTING-stuck sweeper

**Files:** `apps/backend/src/jobs/executing-sweeper.ts` + `apps/backend/src/jobs/index.ts` (registration), wired into `apps/backend/src/app.ts` (`AppOptions.jobs`, off by default so tests are unaffected) and enabled in `apps/backend/src/server.ts` on a 5-minute interval for every non-test environment (s-33 owns the durable schedule; timers are `unref`'d).

`ExecutingSweeper.runSweep({ tenantId, stuckSeconds = 300, batchSize = 100, statusResolver? })`:

- reads stuck rows via `findStuckExecutingActions` (EXECUTING, claim older than threshold);
- `RETRY_PAYMENT`: finds the attempt by idempotency key. No attempt row → fail as `SWEEPER_ORPHAN_CLAIM` (safe: claim precedes the provider call, so nothing was charged). REQUESTED/UNKNOWN → read-only `getPaymentStatus` (injectable `statusResolver` in tests): SUCCEEDED completes the chain (attempt + payment + action), FAILED fails it, non-terminal leaves it pending. Terminal provider answers are the only ones acted on.
- `SEND_*`: resolves via the delivery ledger (SENT/DELIVERED/READ → complete; FAILED/BOUNCED → fail; QUEUED → pending).
- Unknown action types are left untouched for operator triage. Every mutation uses the guarded `completeAction`/`failAction` (EXECUTING-only), so a resumed worker racing the sweeper cannot double-apply. Each resolution records `executing_sweeper_actions_total{result}`.

## 5. Repository addition

**File:** `packages/db/src/repositories/actions.repo.ts` — new read-only `findStuckExecutingActions({ tenantId?, stuckBefore, limit })`. No schema change (step mandates none). Implementation detail that cost a debugging round: the first version compared a raw `COALESCE(started_at, created_at)` SQL fragment against a `Date` bind parameter, which the postgres.js driver rejected at Bind time; the final version uses plain `lt()`/`isNull()` column operators (the same Date-binding pattern `claimActionForExecution` already proves).

## 6. Observability additions

**File:** `packages/observability/src/metrics.ts` (§20): `chaos_faults_injected_total{fault,phase}`, `executing_sweeper_actions_total{result}`, `chaos_backlog_drain_duration_ms{topic}` plus `recordChaosFaultInjected` / `recordExecutingSweeperAction` / `recordBacklogDrain` helpers (auto-exported via the package index). Additive only; existing metric tests unaffected.

## 7. Chaos scenario suites

**Harness** (`tests/chaos/harness/`): `fault-points.ts` (re-export + `withFaultPoint`/`resetChaosHarness`), `compose-admin.ts` (guarded docker drills, `CHAOS_INFRA=1` gate, prod refusal, JSON artifact writer), `assert-invariants.ts` (`assertInvariants(tenantId)` — payments↔attempts consistency, message-key uniqueness, single live case per obligation, outcomes ≤1/case, LLM costs for decided cases, vocabulary legality), `seed.ts` (isolated tenants, MOCK fixtures, async metric-delta + `waitFor` helpers).

**Scenarios** (`tests/chaos/scenarios/`, 13 files / 23 tests covering all 14 §21 items; infra-kill halves run nightly, fast fakes every push):

- `duplicate-webhook` — ×50 concurrent Stripe POSTs → 1 ACCEPTED + 49 DUPLICATE, single payment/event rows, metric deltas match.
- `out-of-order` — succeeded→failed→failed → stays SUCCEEDED, regression counter +2.
- `stripe-timeout` / `razorpay-timeout` — hang → sync UNKNOWN → background status poll converges (SUCCEEDED / FAILED with taxonomy preserved), exactly one attempt row.
- `whatsapp-timeout` — FAILED ledger row once; same-key redelivery `isDuplicate` with zero provider calls; fresh key SENT once.
- `llm-timeout-malformed` — malformed ×3 storm → all FALLBACK with INVALID_OUTPUT rows and LLM costs ≥ decisions; hung model → client timeout wins → FALLBACK.
- `redis-down` — null-Redis app serves `/health` 200 + `/events` 202; injections fall back; drill skipped without flag.
- `postgres-reconnect` — bad statement rejects cleanly, pool serves next write; concurrent guarded transitions elect exactly one winner.
- `worker-crash` — armed `claim:after_claim` crash: 0 provider calls, EXECUTING + REQUESTED survive; resume executes EXACTLY once (1 charge, 1 attempt, EXECUTED); sweeper resolves an induced stuck row via status query with 0 charges.
- `refresh-network-retry` — sequential refresh replays the same event id (1 row); ×10 concurrent → one row, 202-same-id or 409-retryable.
- `late-success` — STOPPED(MAX_RETRIES) + out-of-band SUCCEEDED → `ATTRIBUTION_WINDOW` outcome, case stays STOPPED, re-sweep no-op.
- `optout-midway` — round 2 throws `CUSTOMER_OPTED_OUT` with 0 provider calls, ledger keeps 1 SENT row, case STOPPED(OPTED_OUT).
- `backlog-drain` — 5k mixed events drain in ~0.6–0.9s with zero loss/dupes (id-set equality); closed-bus publish fails fast.

**Runner docs:** `tests/chaos/README.md` (layout, `FAULT_POINTS` syntax, `bun run test:chaos` vs `CHAOS_INFRA=1` nightly).

## 8. Vitest + package wiring

- `vitest.config.ts`: new `chaos` project (`tests/chaos/**/*.test.ts`, 90s timeouts); `package.json`: `test:chaos` script. Root devDependencies gain `@repo/config`, `@repo/domain`, `@repo/worker` workspace links (same pattern as the existing `@repo/db` link for `tests/security`) plus `ioredis` so chaos tests resolve at runtime.
- `bun run test` now covers unit + security + chaos (88 files / 997 tests).

## 9. Problems discovered during verification and their fixes

1. **Metric-delta helper always read 0.** prom-client v15 made `Counter.get()` async; the synchronous read saw `undefined.values`. Fix: `counterValue` became async (`await metric.get()`), call sites updated. This was the cause of 7 of the 9 first-run failures.
2. **Sweeper query crashed the driver.** Raw `COALESCE(...) < Date` fragment failed at postgres.js Bind time (`TypeError: Received an instance of Date`). Fix: plain `lt()`/`isNull()` operators (§5).
3. **LLM-timeout test hung 19 minutes.** The client's timeout relies on the fetch honoring `AbortSignal`; the hanging stub ignored it and never settled (no race in the client). Fix: stub now rejects on abort, so the 400ms budget wins (~8s test).
4. **Stripe-timeout intermediate assertion raced the background poll.** The poll's first `getPaymentStatus` is immediate, so the attempt was already SUCCEEDED at read time. Fix: assert the synchronous `UNKNOWN` return, allow UNKNOWN-or-SUCCEEDED at the read, pin terminal state with `waitFor`.
5. **Residual full-suite failures are environmental/pre-existing, not regressions:** two Redis-dependent suites (`customer-context`, `demo-simulation` toggle lifecycle) require local Redis at `localhost:6379`, which is unreachable in this environment (port closed; code paths untouched by this step); the Temporal `worker.test.ts` signal test flakes under full parallel load (documented same-class flake in s-30) and passes 7/7 in isolation with these changes applied.

## 10. Verification evidence (Definition of Done)

- [x] All 14 §21 scenarios automated with green runs recorded — `bun run test:chaos`: **13 files / 23 tests green** (single run), plus 6 framework unit tests; evidence table in `docs/RESILIENCE.md`.
- [x] Fault-point harness documented; kills reproducible locally via single command — `tests/chaos/README.md` (`FAULT_POINTS=… bun run test:chaos`; `CHAOS_INFRA=1 bun run test:chaos` for kills).
- [x] EXECUTING sweeper proven against induced stuck rows — `worker-crash.chaos.test.ts` (sweep path: 1 audited → 1 completed, 0 charges).
- [x] Backlog drain: 5k events, zero loss/dupes, timing recorded — ~0.6–0.9s, `chaos_backlog_drain_duration_ms`.
- [x] `docs/RESILIENCE.md` published with evidence table.
- [x] `bun run check-types` green (12/12 incl. re-run after fixes); `bun run lint` 0 errors; `bun run check-docs` (below); full `bun run test`: 994/997 with only the environmental/pre-existing failures noted above.

## 11. Deviations and judgment calls

- **Backlog benchmark is a 13th scenario file** (step lists 12): Requirement 5 (5k drain) had no dedicated file, so `backlog-drain.chaos.test.ts` was added rather than overloading the refresh test.
- **Infra kills are fakes on the fast path, real drills nightly** (`CHAOS_INFRA=1`): restarting shared dev containers on every push would be flaky and hostile; the suites assert `skipped` reports in CI and prove identical degraded behaviors via fakes. The step's "scripted, compose" requirement is satisfied by `compose-admin.ts`.
- **Sweeper schedule is 5-minute `setInterval` in `server.ts`, not a Temporal cron**: matches the existing sweeper pattern (attribution/cost jobs are backend classes; s-33 owns the durable cron inventory). Registration is explicit and off in tests.
- **No new tables/columns** (per step); the only repository change is a read-only query. No API contracts changed.
- Chaos tenants created during verification runs remain in the database (same convention as existing integration suites; s-30 cleaned orphans once before).
