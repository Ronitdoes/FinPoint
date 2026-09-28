# Chaos & Resilience Suite (Step 31)

Automated, repeatable failure-testing for Spec 01 §21 (fourteen scenarios).
Financial actions must be idempotent — every scenario proves it.

## Layout

```text
tests/chaos/
├── harness/
│   ├── fault-points.ts       # re-exports @repo/worker/fault-points + withFaultPoint/reset helpers
│   ├── compose-admin.ts      # guarded docker kill drills + JSON report artifact writer
│   ├── assert-invariants.ts  # assertInvariants(tenantId): ledger-wide hard-invariant scan
│   └── seed.ts               # isolated-tenant fixtures, metric-delta + waitFor helpers
├── scenarios/
│   ├── duplicate-webhook.chaos.test.ts   # duplicate webhook (×50 concurrent)
│   ├── out-of-order.chaos.test.ts        # out-of-order succeeded→failed→failed
│   ├── stripe-timeout.chaos.test.ts      # Stripe timeout → UNKNOWN → poll SUCCEEDED
│   ├── razorpay-timeout.chaos.test.ts    # Razorpay timeout → UNKNOWN → poll FAILED
│   ├── whatsapp-timeout.chaos.test.ts    # WhatsApp dispatch failure, no double-send
│   ├── llm-timeout-malformed.chaos.test.ts # LLM timeout + malformed storm → fallback
│   ├── redis-down.chaos.test.ts          # Redis unavailable → degraded-not-dead
│   ├── postgres-reconnect.chaos.test.ts  # PG drop → clean failures + single winner
│   ├── worker-crash.chaos.test.ts        # SIGKILL after claim → exactly-once resume + sweeper
│   ├── refresh-network-retry.chaos.test.ts # browser refresh / network retry on POST /events
│   ├── late-success.chaos.test.ts        # payment succeeds after STOPPED → attribution
│   ├── optout-midway.chaos.test.ts       # customer opts out between rounds
│   └── backlog-drain.chaos.test.ts       # 5k mixed events → zero loss/dupe drain benchmark
└── README.md
```

The EXECUTING-stuck sweeper itself lives at
`apps/backend/src/jobs/executing-sweeper.ts` (registered via
`apps/backend/src/jobs/index.ts`, enabled in non-test `server.ts` on a
5-minute interval); it is proven by `worker-crash.chaos.test.ts`.

## Fault points

Deterministic breakpoints, no scattered env branches. Arm via env:

```bash
FAULT_POINTS=claim:after_claim bun run test:chaos
FAULT_POINTS=executeRetryPayment:before_provider_call,sendTemplateMessage:after_provider_call bun run test:chaos
```

Format is `<activity>:<phase>` (activity `*` matches all); phases are
`pre | post | after_claim | before_provider_call | after_provider_call`.
An armed point throws `FaultInjectedError` (SIGKILL analogue). Tests prefer
`armFaultPoint()` / `withFaultPoint()` (no restart needed). Production is a
no-op unless `CHAOS_ENABLED=true`, and compose drills refuse prod-shaped env.

## Running

```bash
# Fast subset (every push): all scenarios with fakes, no infra kills
bun run test:chaos

# Full suite
bun run test

# Nightly infra-kill matrix (composed stack, destructive to dev containers)
CHAOS_INFRA=1 bun run test:chaos
```

`CHAOS_INFRA=1` enables the real drills: `docker restart redis`, 30s Postgres
pause, worker SIGKILL, Redpanda stop/start. Without the flag each drill
returns a `skipped` report (asserted by the suites) so CI stays green while
the same degraded behaviors are proven via fakes.

## Nightly schedule

There is no dedicated `chaos-nightly.yml` workflow. The nightly
infra-kill matrix is the same command run against the composed stack:

```bash
CHAOS_INFRA=1 bun run test:chaos
```

Recommended fold-in (not a duplicate workflow): add it as a job to the
existing nightly `.github/workflows/perf-gate.yml` (03:00 UTC schedule),
gated on composed-stack readiness the same way the staging-load job is
gated on staging secrets. Until that fold-in lands, the nightly run is an
operator/cron invocation of the command above.

## Hygiene: chaos tenants left in the DB

Chaos scenarios create isolated tenants per run (`slug LIKE 'chaos-%'`,
same convention as the integration suites) and leave them in the database
for post-run evidence — this is intentional, not a leak. To clean up
hygiene rows on a dev database after a verification session:

```sql
DELETE FROM tenants WHERE slug LIKE 'chaos-%';
```

(Orphaned financial rows are tenant-scoped and go with the tenant via
`ON DELETE CASCADE`; never run this against staging/prod — chaos drills
refuse prod-shaped envs by design.)

## Reports

Kill drills write JSON artifacts (`artifacts/chaos/chaos-drills-*.json`) for
the CI summary; scenario evidence lives in `docs/RESILIENCE.md`.
