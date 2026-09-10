# Performance Measurements vs MVP Targets (s-34)

Spec 03 §10: *"Measure actual values rather than claiming them."* Every
number below was produced by `scripts/load-lite.mjs` (committed) and can be
reproduced with the commands shown. The archived baseline for the nightly
regression gate is `infra/load/baseline.local.json` (this run).

## 1. Results (2026-09-10)

Environment: Windows dev machine → **co-located** stack
(`DATABASE_URL=postgres://…@localhost:5432` via compose `arr-postgres`,
`REDIS_URL=redis://localhost:6379`, in-process Fastify via `app.inject`,
`MOCK_PROVIDERS=true`, rate limiting ON).
Reproduce: `DATABASE_URL=postgres://postgres:postgres@localhost:5432/revenue_recovery DIRECT_URL=… bun scripts/load-lite.mjs --phase all --webhook-n 300 --reads-n 200`

| # | Target (spec 03 §10) | Measured | n | Verdict |
|---|---|---|---|---|
| 1 | Webhook response **<300ms** for accepted async event | p50 **30.0ms**, p95 **50.9ms**, p99 103.5ms, max 108.8ms (300/300 ACCEPTED) | 300 signed `payment_intent.payment_failed`, concurrency 10 | ✅ PASS |
| 2 | API reads p95 **<500ms** (normal reads) | p50 **4.5ms**, p95 **15.4ms**, p99 33.5ms (200/200 HTTP 200: `GET /analytics/summary`, `/cases?limit=20`, `/risks?limit=20` as FINANCE session) | 200 | ✅ PASS |
| 3 | Policy evaluation **<50ms** | p50 0.01ms, p95 **0.02ms** (pure `evaluate()` + default rules, 2-action proposal) | 1000 | ✅ PASS |
| 4 | Risk calculation **<50ms** | p50 0.00ms, p95 **0.01ms** (pure `scorePaymentFailure`) | 1000 | ✅ PASS |
| 5 | LLM decision **<5s typical** | Fallback path p95 **0.0ms** (n=200, zero provider cost). **Live-model typical: not measurable from this environment** — dev `LLM_API_KEY` is unset (probe fails fast with HTTP 401 in 677ms, no latency signal). Staging fills this cell via the s-15 harness: `bun run --filter @repo/eval eval` (live mode tracks per-case `latency_ms`; report gate `<2,500ms` mean). Until then the <5s budget is held by construction: 20s timeout, N=2 bounded retries, deterministic fallback on any failure. | 200 + harness | ⚠️ PARTIAL (staging TODO) |
| 6 | **Zero duplicate financial actions** under load | 50 identical concurrent deliveries → **exactly 1 ACCEPTED + 49 DUPLICATE**, single payment row (`events(source,external_event_id)` anchor) | 50-way storm | ✅ PASS |
| 7 | **100% of sensitive actions auditable** | `audit_write_failures_total == 0`; immutability enforced by DB triggers (`prevent_audit_modification`, s-25, 19 tests) + append-only compile/runtime guards (s-06) | suite | ✅ PASS (by test + trigger, see §3) |

Headroom summary: webhook p95 runs at **17%** of budget, reads at **3%**,
policy at **0.04%**, risk at **0.02%**. The nightly perf-gate fails on
**>20% regression** vs `infra/load/baseline.local.json` (promoted to a
staging baseline on first staging run — see §4).

## 2. What the numbers include (and exclude)

- **Webhook** = full synchronous ingest path per request: HMAC verify →
  normalize → transactional core upsert (customer/payment/event rows) →
  idempotency anchor → fire-and-forget bus dispatch. Consumers are
  intentionally **not** in the window (black-hole bus mirrors the
  production Redpanda path where `ingest.service` resolves after dispatch;
  verified in code — `publish(...).then(markProcessed)`, never awaited).
- **Reads** = authenticated end-to-end API latency incl. RBAC, tenant
  scoping, analytics SQL aggregations, and the 30s single-flight cache
  (mixed hit/miss across the 200 requests).
- **Policy/Risk/LLM-fallback** = pure CPU benches of the exact functions on
  the hot path (no I/O), so they read as sub-millisecond. DB-backed policy
  *snapshot loading* is part of the reads/webhook numbers, not hidden.
- **Excluded:** live-model LLM latency (see row 5), browser rendering,
  cross-region network (see §3).

## 3. Cross-region control experiment (why staging must re-measure)

Same webhook phase against the cloud dev DB (Neon, `SELECT 1` RTT **924ms**
from this machine): p50 **2,089ms**, p95 **2,589ms** — every webhook pays
~3–6 sequential DB round trips, so ~1s RTT dominates completely. An early
run also caught the harness measuring the **NullBus inline cascade**
(risk→case→pipeline→live-LLM-timeout, p95 **14.6s**); both artifacts are
documented here so nobody re-learns them:

1. Measure ingest against a **co-located** database (staging DB in-region).
2. Never measure response latency with `NullBus` — it awaits consumers
   inline; production never does.

## 4. Regression gate & baseline promotion

- Nightly workflow `.github/workflows/perf-gate.yml`: `monitoring-check`
  (rules/dashboards/label audit) + `load-lite --phase policy,risk,llm`
  (infra-free, no secrets) + comparison of the committed baseline with
  20% tolerance.
- `infra/load/baseline.local.json` is the **local** archive. The first
  staging run (`k6 run infra/load/k6-smoke.js` + load-lite `--phase
  webhook,reads` vs staging) promotes values into a new
  `infra/load/baseline.staging.json` (absent until then) and flips the
  gate's comparison target — procedure documented in the
  `.github/workflows/perf-gate.yml` header.
- Staging k6 mix: webhook burst **100 rps × 60s** + reads **50 rps × 60s**,
  gates `webhook p95<300ms`, `reads p95<500ms`, `checks rate==1.0`.
