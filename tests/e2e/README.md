# E2E Acceptance Suite (s-32)

Release gate proving spec 01 §29's 18-item definition-of-done journey plus every
acceptance block from spec 03 §8, against the fully composed stack with mock
providers.

## Two execution modes

| Mode | How | When |
|---|---|---|
| **In-process (default, fast)** | `buildApp` + `InProcessEventBus` + real Postgres/Redis via `infra:up`; Temporal/Redpanda via in-process driver or `DefaultWorkflowClient` DB row | Local dev, CI fast gate (`bun run test:e2e`), wall-clock target ≤10min |
| **Composed (`e2e` profile)** | `docker compose -f tests/e2e/setup/compose.e2e.yml up` (fresh volumes), migrations, minimal seed, API+worker, `E2E_BASE_URL` pointed at the composed API | Nightly / pre-release, restart-variant with real `kill -9` |

Both modes execute **public surface only** (+`/demo/*` simulation endpoints).
No test-only backdoors exist: any read capability an assertion needs comes from
an existing filtered endpoint or repository reader already used in production.

## Local run

```bash
bun run infra:up
bun run db:migrate
bun run test:e2e            # in-process fast path (default)
bun run test:e2e:coverage   # §29 marker audit, must report 18/18

# Full composed profile (optional, needs docker):
docker compose -f tests/e2e/setup/compose.e2e.yml up -d --build --wait
E2E_BASE_URL=http://localhost:4000 bun run test:e2e
```

## Layout

```text
tests/e2e/
├── setup/compose.e2e.yml      # e2e compose profile (fresh volumes, MOCK_PROVIDERS=true)
├── setup/readiness.ts         # HTTP readiness probes (/health, /ready)
├── setup/global-setup.ts      # vitest globalSetup (waits ready, logs mode)
├── fixtures/scenario-{a,b,c}.json  # minimal deterministic fixtures (NOT s-29 volume)
├── support/e2e-harness.ts     # app boot, tenant/auth factory, mock LLM, waitFor, counters
├── support/expect-journey.ts  # 18 × [DOD-NN] check functions (traceability lives in code)
├── journeys/full-recovery.e2e.test.ts
├── journeys/restart-resilience.e2e.test.ts
├── acceptance/payment-recovery.acceptance.test.ts  # AC-PAY-1..4
├── acceptance/checkout.acceptance.test.ts          # AC-CO-1..2
├── acceptance/invoice-highvalue.acceptance.test.ts # AC-INV-1
└── ui/dashboard.smoke.e2e.ts
```

## Flakiness policy (step §Reliability)

Retries are **forbidden** at runner level. `retry=1` is allowed ONLY for
infra-readiness waits (`setup/readiness.ts`), never for assertions. Any red run
requires reproduction before re-run.

## Suite isolation

- **Tenants:** every file boots an isolated tenant (the fast-path analog of
  "fresh volumes"); all financial rows are tenant-scoped.
- **Redis:** e2e apps connect to logical DB index 1 (`createIsolatedRedis`,
  flushed on boot). Failure-injection flags are *global* Redis keys, and unit
  suites (e.g. s-29 demo-simulation) set `simulate_llm_failure=true` with a
  15m TTL — without isolation those flags leak into concurrent e2e journeys
  and flip COMPLETED decisions to FALLBACK. Proven by running the flagship
  journey concurrently with the polluting suite (both green).
- **LLM:** a global fetch stub serves the deterministic mock model only for
  `/chat/completions` traffic; all other fetch traffic delegates to the real
  implementation. Vitest isolates files, so stubs never leak across suites.

## Traceability

Each numbered §29 item maps to exactly one `expectDodNN*` helper in
`support/expect-journey.ts`, tagged with an inline `[DOD-NN]` marker.
`scripts/e2e-coverage-check.mjs` counts markers and fails if <18.
Spec 03 §8 blocks map to `AC-*` test titles in `acceptance/`.
