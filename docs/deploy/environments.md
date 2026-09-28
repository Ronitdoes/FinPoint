# Environments — Local / Staging / Production (s-33)

How the platform is shaped in each environment: topology, every environment
variable and who owns it, the secret strategy, and the probe contract.
Source of truth for values: [`.env.example`](../../.env.example) (local
defaults) — staging/prod values live in the platform secret store, never in
git (CONVENTIONS §12).

Companions: [`migrations.md`](./migrations.md) (pre-deploy job),
[`webhooks.md`](./webhooks.md) (per-env endpoint registration),
[`crons.md`](./crons.md) (job inventory), [`rollback.md`](./rollback.md).

> Execution status: everything repo-side (pipeline, images, gates, docs,
> schedules) is complete and locally verified. The three live items — CI
> green on a pushed branch, staging cutover with TEST-mode provider
> registration, and the full rollback drill — are operator steps executed at
> first staging deploy once the remote account + secrets exist (checklist in
> the workflow headers). The procedures below are execution-ready; no
> improvisation is left to deploy time.

---

## 1. Topology matrix

| Concern | Local (compose) | Staging | Production |
|---|---|---|---|
| Postgres | composed `postgres:16-alpine`, single DB | Managed PG + pooler; `DATABASE_URL` (pooled) and `DIRECT_URL` (direct) are DIFFERENT hosts | Same as staging + PITR enabled, HA; `DIRECT_URL` direct, never pooled |
| Redis | composed `redis:7-alpine`, no auth | Managed Redis, auth + persistence | Same + persistence, separate instance per env |
| Temporal | composed `auto-setup:1.28.0`, namespace `revenue-recovery` | Temporal Cloud OR self-host single-binary; namespace `revenue-recovery-staging` | Same; namespace `revenue-recovery-production` (one namespace PER env — never shared) |
| Event bus | `inprocess` default; Redpanda composed for visibility | Redpanda (`EVENT_BUS_DRIVER=redpanda`) | Same, HA topic config |
| API | compose `backend` (image `api` mode), 1 replica, `:4000` | Same image, **2 replicas behind LB** | Same image, 2+ replicas behind LB, rolling updates |
| Worker | compose `--profile worker` (image `worker` mode), 1 replica | Same image, **pool of 2** | Same image, pool of 2+, drain before termination |
| Frontend | compose `frontend` or `next dev`, `:3000` | Vercel preview/staging project | Vercel production project |
| Migrations | `bun run db:migrate` vs composed PG | Pre-deploy job on `DIRECT_URL` ([`migrations.md`](./migrations.md)) | Same, owner-approved window for breaking (expand→contract) changes |
| Providers | `MOCK_PROVIDERS=true` | `MOCK_PROVIDERS=false` + provider **TEST** keys; real webhooks to staging domains | `MOCK_PROVIDERS=false` + **LIVE** keys |
| Demo routes | present | **omitted** (prod-shape); time-boxed drill shape documented below | omitted |

Compose profiles (finalized s-33): `default` = dev services (no worker);
`worker` = adds the unified-image worker (`docker compose --profile worker
up`); `e2e` = [`tests/e2e/setup/compose.e2e.yml`](../../tests/e2e/setup/compose.e2e.yml)
(fresh volumes, `MOCK_PROVIDERS=true`, never live credentials). Production
never uses compose files — they are local/test tooling.

---

## 2. Environment variable matrix

Legend — **Local**: value from `.env.example` / compose; **Staging/Prod**:
`secret ref` = platform secret store injected at runtime (Railway/Render/AWS
Secrets Manager/Vercel env), `baked` = image build arg (metadata only),
`—` = unused. **Consumed by**: which component reads it (via `@repo/config`;
frontend reads only `NEXT_PUBLIC_*` via `webConfig`).

| Variable | Local default | Staging | Prod | Consumed by |
|---|---|---|---|---|
| `NODE_ENV` | `development` | `production` | `production` | api, worker, migrate |
| `DEPLOY_ENV` | `local` | `staging` | `production` | api, worker (log/metrics label) |
| `APP_VERSION` / `GIT_SHA` | `dev` | baked (tag/sha) | baked (tag/sha) | api (`GET /version`, smoke check) |
| `PORT` | `8000` (`4000` in compose) | platform-assigned | platform-assigned | api |
| `LOG_LEVEL` | `info` | `info` | `warn` | api, worker |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | baked per env (staging API URL) | baked per env (prod API URL) | frontend ONLY (sole permitted build arg) |
| `DATABASE_URL` | composed PG | secret ref (pooled) | secret ref (pooled, HA) | api, worker, migrate fallback |
| `DIRECT_URL` | same as above | secret ref (direct, REQUIRED) | secret ref (direct, REQUIRED) | migrate job (DDL bypasses pooler) |
| `REDIS_URL` | `redis://localhost:6379` | secret ref | secret ref | api, worker |
| `TEMPORAL_ADDRESS` | `localhost:7233` | secret ref | secret ref | api (client), worker (poller) |
| `TEMPORAL_NAMESPACE` | `revenue-recovery` | `revenue-recovery-staging` | `revenue-recovery-production` | api, worker |
| `TEMPORAL_TASK_QUEUE` | `recovery-main` | `recovery-main` | `recovery-main` | api, worker |
| `EVENT_BUS_DRIVER` | `inprocess` | `redpanda` | `redpanda` | api, worker |
| `REDPANDA_BROKERS` | `localhost:9092` | secret ref | secret ref | api, worker |
| `SESSION_SECRET` | dev default (override anytime) | secret ref (32+ chars) | secret ref (rotated, 32+ chars) | api |
| `BOOTSTRAP_ADMIN_*` | example values | secret ref (one-time seed) | secret ref (one-time seed) | api seed script |
| `LLM_API_KEY` / `AI_MODEL` / `LLM_BASE_URL` / `LLM_TIMEOUT_MS` / `LLM_MAX_RETRIES` | empty / `gpt-4o` / 20s / 2 | secret ref (scoped TEST key, budgeted); `AI_MODEL` may differ from prod for cost | secret ref (scoped LIVE key, budgeted); model pinned | api (AI service), worker (activities) via `packages/integrations` only |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | `sk_test_…` / `whsec_…` placeholders | secret ref (TEST mode) | secret ref (LIVE mode) | integrations (payments), webhooks |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` | placeholders | secret ref (TEST) | secret ref (LIVE) | integrations, webhooks |
| `WHATSAPP_API_KEY` / `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_VERIFY_SECRET` | empty | secret ref (TEST number) | secret ref (LIVE number) | integrations (messaging), webhooks |
| `EMAIL_API_KEY` / `EMAIL_FROM` / `EMAIL_WEBHOOK_SECRET` | empty | secret ref | secret ref | integrations, webhooks |
| `MOCK_PROVIDERS` | `true` | **`false` (forced)** | **`false` (forced)** | api, worker (fail-fast requires all live keys) |
| `SIMULATE_*` (4 flags) | `false` | `false` (never on) | `false` (never on) | api, worker (injection switches) |
| `FAULT_POINTS` / `CHAOS_ENABLED` / `CHAOS_INFRA` / `CHAOS_TARGET` | empty / `false` / `0` | unset / `false` | unset / `false` (never point at prod tenants) | worker, chaos drills |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | empty | secret ref / collector URL | secret ref / collector URL | api, worker |
| `CRON_ENABLED` | `true` | `true` | `true` | api, worker (master cron toggle) |
| `ATTRIBUTION_SWEEP_INTERVAL_MS` | hourly (3600000) | hourly | hourly | api |
| `COST_AUDIT_INTERVAL_MS` | daily (86400000) | daily | daily | api |
| `RECONCILE_INTERVAL_MS` | daily | daily | daily | worker |
| `RETENTION_SWEEP_INTERVAL_MS` | monthly (30d) | monthly | monthly | api |

### Hard rules (asserted at boot, verified by smoke)

1. **Staging/prod force `MOCK_PROVIDERS=false`.** `@repo/config` fail-fast
   then requires every live provider key and lists precisely which are
   missing; the container exits before serving traffic.
2. **Demo routes are absent in prod-shape.** When `NODE_ENV=production` AND
   `MOCK_PROVIDERS=false`, `/demo/*` is not registered at all (missing
   routes return 404, not 410). The API logs `demoRoutes: omitted` in the
   boot self-check line (`server.ts`); the staging smoke script asserts the
   404 (`scripts/smoke-staging.mjs`, strict mode).
3. **Staging demo drill (temporary toggle, documented):** the ONE full demo
   scenario reproducible on staging runs as a time-boxed redeploy with
   `MOCK_PROVIDERS=true` (routes register, `demoGuard` passes), after which
   staging is redeployed prod-shape (`MOCK_PROVIDERS=false`) and the smoke
   script re-verifies the 404. No live provider is ever touched by the
   simulator: mock mode forces mock adapters.
4. **Secrets never enter images or git.** Images carry only `GIT_SHA` /
   `APP_VERSION` metadata; frontend build args are `NEXT_PUBLIC_*` only
   (CI `deploy-check` fails any other `ARG`).

---

## 3. Probe contract (LB → API)

| Probe | Target | Expectation | Intervals |
|---|---|---|---|
| Liveness | `GET /health` | `200 { status: "ok" }`, no dependency checks | period 15s, timeout 5s, start-period 25s, retries 3 (image `HEALTHCHECK`; LB equivalent) |
| Readiness | `GET /ready` | `200 { isReady: true }` (DB up AND Redis up/disabled); `503` removes the replica from rotation | LB health-check 10–15s; app caches the check 5s |
| Version | `GET /version` | `200 { version, gitSha, env }` — smoke asserts `gitSha` equals the deployed tag | post-deploy only |
| Metrics | `GET /metrics` | `200` Prometheus exposition | scrape 15s (s-34 dashboards) |

Workers expose no HTTP port: the image `HEALTHCHECK` MUST be disabled for
worker containers (`test: ["NONE"]` in compose; platform equivalent e.g.
`no_healthcheck`). Worker supervision = Temporal UI (task-queue backlog),
`GET /metrics` on the API, and cron pass logs. Temporal workers drain
before termination: SIGTERM → poller shutdown + in-flight activity drain
(`services/worker/src/worker.ts`), with a platform `preStop` sleep so the
LB stops routing first; bus consumers commit offsets before exit.

---

## 4. AI behavior per env

Prod LLM key is scoped (least privilege) and budgeted (provider-side spend
cap + alert); model pinned per env via `AI_MODEL` (staging may run a
cheaper model — cost/quality deltas are expected and must not gate staging).
Circuit-breaker thresholds (5 failures / 60s cooldown, 20s timeout, N=2
retries) are reviewed against the real staging latency profile before the
production cutover; tightening/loosening is a config change, not a deploy.
