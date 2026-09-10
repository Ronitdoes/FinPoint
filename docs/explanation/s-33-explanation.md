# s-33 — CI/CD & Deployment: Implementation Explanation

This document explains, in complete depth, everything that was done to
implement `specs/steps/s-33.md`. It is written so that a developer (or future
agent) who was not present during implementation can understand every file,
every decision, every deviation, and every problem debugged along the way.

---

## Table of contents

1. [What the step required](#1-what-the-step-required)
2. [Production images (`infra/docker/`)](#2-production-images-infradocker)
3. [Compose profiles finalized](#3-compose-profiles-finalized)
4. [CI/CD workflows (`.github/workflows/`)](#4-cicd-workflows-githubworkflows)
5. [Deploy scripts (`scripts/`)](#5-deploy-scripts-scripts)
6. [Cron inventory (config + backend jobs + worker scheduler)](#6-cron-inventory-config--backend-jobs--worker-scheduler)
7. [Deploy runbooks (`docs/deploy/`)](#7-deploy-runbooks-docsdeploy)
8. [Startup self-check tests](#8-startup-self-check-tests)
9. [Problems discovered during verification and their fixes](#9-problems-discovered-during-verification-and-their-fixes)
10. [Verification evidence (Definition of Done)](#10-verification-evidence-definition-of-done)
11. [Deviations and judgment calls](#11-deviations-and-judgment-calls)

---

## 1. What the step required

Step s-33 delivers the **deployment system**: the GitHub Actions pipeline
(lint → typecheck → test pyramid → build → image publish → migrate-check →
deploy gates), production Dockerfiles for API/worker/frontend, the
Local/Staging/Production environment matrix with config and secret strategy,
the migration execution policy, webhook endpoint configuration, the rollback
procedure, and the deployed cron inventory.

Per spec 01 §26 the targets are Vercel (Next.js), AWS/Railway/Render
(API + workers + Postgres + Redis + Redpanda), and Docker for API/workers,
with CI stages lint / typecheck / unit / integration / build / migration
checks. The acceptance bar is implementation-readiness: a future operator
follows this step's runbooks and ships without improvisation.

### Definition of Done checklist (from `specs/steps/s-33.md`)

- CI green end-to-end on a clean branch including e2e gate
- Staging environment live w/ real test-mode providers receiving signed webhooks
- One full demo scenario reproducible on staging via simulator (temporary toggle documented)
- Migration executed on staging via pipeline; migrate:check gate proven (bad-state rejection)
- Rollback drill completed and documented
- Cron inventory live and observable in logs/metrics

The repo-side deliverables (pipeline, images, gates, docs, schedules) are
complete and verified below. The three items that require a live staging
account (staging cutover, live signed-webhook receipt, live rollback drill)
are operator-executed at first deploy using the runbooks in
`docs/deploy/` — the drill log in `docs/deploy/rollback.md` records the
local-harness evidence plus the exact operator procedure, so nothing is left
to improvisation.

---

## 2. Production images (`infra/docker/`)

Canonical images live in `infra/docker/` (the step's file list);
`apps/backend/Dockerfile` and `apps/frontend/Dockerfile` carry byte-identical
stage bodies as twins for historical references (compose files, READMEs, the
s-30 audit script all pointed there). CI `deploy-check` diffs the twins
ignoring comment/blank lines and fails on drift.

### 2.1 Unified backend image (`backend.Dockerfile` + `backend-entrypoint.sh`)

**One image, four entries** — this is the step's "identical image for API &
worker (entry differs)" requirement, extended with the migration job so the
pre-deploy step runs the exact bytes being deployed:

```text
docker run … arr-backend:<tag> api            # Fastify API (default CMD)
docker run … arr-backend:<tag> worker         # Temporal worker
docker run … arr-backend:<tag> migrate        # pre-deploy migrations (DIRECT_URL)
docker run … arr-backend:<tag> migrate:check  # CI/deploy gate
```

Stages: `deps` (full workspace `bun install --frozen-lockfile`) → `build`
(`bun run --cwd apps/backend build`) → `prod-deps` (fresh
`bun install --production --frozen-lockfile`, devDependencies pruned) →
`runner` (digest-pinned `oven/bun:1.4-alpine`, non-root `appuser:1001`).
The runner copies prod `node_modules`, `apps/backend`, `packages`, and
`services/worker` (the old Dockerfile omitted the worker source, so the
unified image would not have booted in worker mode — fixed here). Only
metadata build args exist (`GIT_SHA`, `APP_VERSION`, surfaced by
`GET /version` for the smoke sha-match); no secrets in args or layers.

The entrypoint (`backend-entrypoint.sh`, POSIX `sh`, no dependencies)
validates required vars per mode BEFORE bun boots and fails LOUDLY
(exit 2) listing every missing key:

- `api` / `worker`: `DATABASE_URL REDIS_URL TEMPORAL_ADDRESS TEMPORAL_NAMESPACE`
- `migrate` / `migrate:check`: `DATABASE_URL` (+ warns when `DIRECT_URL` is
  unset, since DDL over a pooler is the staging/prod failure mode)
- unknown mode → usage error, exit 2

Deeper validation (live provider keys when `MOCK_PROVIDERS=false`, bus
consistency) stays in `@repo/config`, which throws `ConfigValidationError`
with the same loud list — the entrypoint covers infra vars fast, config
covers domain vars precisely. Every boot logs
`mode / version / sha / env / mockProviders / demoRoutes` for the operator.

`HEALTHCHECK` probes `GET /health` on `$PORT` (15s period, 5s timeout, 25s
start-period, 3 retries) — the same target LBs use. Worker containers MUST
disable it (`test: ["NONE"]`): workers expose no HTTP port and are
supervised via Temporal UI, `GET /metrics`, and cron logs. `deploy-check`
enforces this on every compose file.

### 2.2 Frontend image (`frontend.Dockerfile`)

Same shape as before (bun build → `node:20-alpine` standalone runner,
non-root `nextjs:1001`) plus: `HEALTHCHECK` on `GET /`, and a hard policy —
**`NEXT_PUBLIC_*` is the only permitted build arg**, because Next.js inlines
those into the client bundle at build time and any other `ARG` would bake a
secret into image layers (CONVENTIONS §12). `deploy-check` extracts every
`ARG` from both frontend Dockerfiles and fails on any non-`NEXT_PUBLIC_*`
name.

---

## 3. Compose profiles finalized

`infra/docker/docker-compose.yml` header now documents the finalized
profiles against production assumptions (`docs/deploy/environments.md`):

| Profile | Services | When |
|---|---|---|
| default (dev) | postgres, redis, temporal, temporal-ui, redpanda, console, otel-collector, backend (`api`), frontend | `bun run infra:up` — unchanged, lean |
| `worker` | + `worker` (unified image, `command: ["worker"]`, healthcheck disabled, `CRON_ENABLED=true`) | `docker compose --profile worker up` — local full loop (workflows actually execute) |
| `e2e` | overrides in `tests/e2e/setup/compose.e2e.yml` (fresh volumes, pinned `MOCK_PROVIDERS=true`, `restart: "no"` worker) | nightly / pre-release; never live credentials |

Backend/frontend builds now reference the canonical
`infra/docker/*.Dockerfile` with `GIT_SHA`/`APP_VERSION` build args, and the
backend service gained `DEPLOY_ENV` + `TEMPORAL_TASK_QUEUE` for log/scheduler
clarity. The e2e worker previously referenced `services/worker/Dockerfile`,
which **does not exist** (dead reference — the e2e composed profile could
never build its worker); it now builds the unified image in worker mode with
the HTTP healthcheck disabled and a `temporal` dependency added (the old
override only waited on postgres/redis, so the worker could boot before its
broker existed).

---

## 4. CI/CD workflows (`.github/workflows/`)

### 4.1 `ci.yml` — eleven stages, one chain

```text
setup (bun cache) → lint → check-types → unit (infra-free subset) →
integration (compose postgres/redis/temporal/redpanda + full unit project) →
security (sweep + audit + test:security) → build (images + deploy-check +
image-smoke) → migrate:check (ephemeral pg, bad-state proof both ways) →
e2e (services + test:e2e + coverage audit) → publish (GHCR, sha + semver) →
deploy-staging (manual approval via `staging` environment) → smoke
```

Notable mechanics:

- **Fresh services per job.** Every job gets its own postgres/redis
  containers (GitHub `services:` or compose with `-v` teardown). Sharing
  Redis across suites trips the s-30 signature-abuse IP block and turns
  green suites red — learned empirically during this step (section 9.1) and
  recorded in the workflow header so nobody "optimizes" it away.
- **Unit split.** `unit` runs the infra-free subset (`packages/domain`,
  `packages/policy`, `packages/config`, `packages/observability`,
  `services/eval`, `apps/frontend`); `integration` brings compose services,
  runs `db:migrate`, then the FULL unit project (backend suites need
  postgres/redis; Temporal suites use the in-process test server).
- **Image smoke in `build`.** `docker run --rm arr-backend:ci api` (and
  `worker`) with minimal env must exit non-zero LISTING the missing keys —
  the s-33 "fail LOUDLY" contract as an executable gate, not a doc claim.
- **Gate proof in `migrate-check`.** `db:migrate:check` must FAIL on the
  fresh database first (bad-state rejection evidence), then PASS after
  `db:migrate`. A gate that cannot say no is decorative; CI proves both
  directions every run.
- **Publish** (main/tags only) pushes both images to GHCR with
  `sha-<sha>` + semver + `latest` (default branch) via
  `docker/metadata-action`; registry auth is `GITHUB_TOKEN` (no long-lived
  keys). Cloud deploys use OIDC-scoped credentials per `environments.md`.
- **Deploy-staging** calls the reusable workflow (section 4.2); the
  `staging` environment's protection rules (required reviewers, configured
  in repo settings) ARE the manual-approval gate.

### 4.2 `deploy-staging.yml` — migrate → deploy → smoke

Callable (`workflow_call`) or manual (`workflow_dispatch`, for redeploys and
the staging demo drill). The `migrate` job runs `db:migrate` +
`db:migrate:check` on staging `DIRECT_URL` BEFORE the platform hook fires
(hook URL from `STAGING_DEPLOY_HOOK_URL` secret, immutable `image_tag` in
the payload), then `smoke` runs `scripts/smoke-staging.mjs` with
`SMOKE_EXPECT_SHA=${{ github.sha }}` so a stale replica set fails the
deploy. Required secrets are listed in the workflow header and
`environments.md`; a missing hook URL fails with a clear message.

### 4.3 `rollback.yml` — verify, then redeploy

Manual-only. `compat-check` runs `scripts/rollback-compat-check.mjs`
(`ROLLBACK_TAG` + `CONFIRM_SCHEMA_COMPAT=true` + green `migrate:check` vs
the target env) before the platform hook redeploys the previous tag
(`{"rollback":true}`), then post-rollback `smoke`. The workflow supports
`staging` (default) and `production` (inherits that environment's
protection rules). PITR is documented as owner-approved last resort, never
automated.

---

## 5. Deploy scripts (`scripts/`)

| Script (root npm alias) | Contract |
|---|---|
| `deploy-check.mjs` (`deploy:check`) | Dockerfile hygiene (frozen + digest pins on all four images), twin sync, frontend `NEXT_PUBLIC_*`-only ARG allowlist, entrypoint mode coverage + loud-fail marker, worker healthcheck policy on compose files, presence of all workflows/scripts/docs. Runs in CI `build` and locally. |
| `smoke-staging.mjs` (`smoke:staging`) | `@smoke` journey-lite: `/health` ok → `/ready` ready → `/version` (+ sha match) → `/metrics` families → `/cases` 401 negative → `/demo` 404 prod-shape (strict mode; non-strict reports drill shape). Exit 1 on any red check. |
| `rollback-compat-check.mjs` (`rollback:compat-check`) | Requires `ROLLBACK_TAG` + `CONFIRM_SCHEMA_COMPAT=true`, then green `migrate:check` (schema at latest = N/N+1 precondition holds). Prints the forward-only acknowledgment on success. |
| `dependency-audit.mjs` (extended) | Dockerfile hygiene list widened from two to all four images (canonical + twins). |

---

## 6. Cron inventory (config + backend jobs + worker scheduler)

The step's table (attribution hourly, cost-completeness daily, invoice
reconciler + PTP expiry daily, retention stub monthly) is now **scheduled
in-process**, with a platform-scheduler mapping documented as the HA
alternative (`docs/deploy/crons.md` §3, toggled by `CRON_ENABLED=false` so
passes never double-run).

- **Config** (`packages/config`): new `cronSchema` — `CRON_ENABLED`
  (defaults ON except in `test`, same convention as `MOCK_PROVIDERS`),
  plus four interval vars with the documented defaults. Surfaced as frozen
  `ServerConfig.cron`; `.env.example` gained the section. Additive only —
  all 13 pre-existing config tests still pass untouched.
- **API** (`apps/backend/src/jobs/`): `registerJobs` grew `attributionSweeper`,
  `costCompleteness`, and `auditRetention` options on top of the s-31
  `executingSweeper`; all four run through the new `scheduleCronJob`
  helper — overlap-guarded (in-flight tick ⇒ skip + warn, never parallel),
  failure-logged-and-continuing, `unref`'d timers, `stopJobs` decoration.
  `server.ts` enables the full inventory in every non-test env with
  `CRON_ENABLED` respected, and logs the boot self-check line
  (version/sha/env/mock/demo-routes) the smoke runbook asserts on.
- **Worker** (`services/worker/src/cron/scheduler.ts`): `WorkerCronScheduler`
  runs `DailyReconciler` (orphaned OVERDUE invoices + expired PTPs) across
  every tenant (paged `listTenants`, injectable for tests) with per-tenant
  try/catch (one tenant's failure never aborts the pass), the same overlap
  guard, and `unref`'d timing. `runWorker` starts it when
  `cron.enabled && env !== "test"` and stops it FIRST on SIGTERM so poller
  drain never hangs on cron. Exported from `@repo/worker` index.

---

## 7. Deploy runbooks (`docs/deploy/`)

| Doc | Content |
|---|---|
| `environments.md` | Topology matrix (local/staging/prod), the full env-var matrix (every `.env.example` var: local default, staging/prod secret ref, consuming component), the four hard rules (MOCK forced false, demo omitted, staging drill toggle, secrets never in images/git), LB probe contract with intervals, per-env AI key/model policy. |
| `migrations.md` | Runner guarantees (advisory lock 724193, transient retry, direct connection), pre-deploy execution order, the N/N+1 compatibility contract with expand→contract rules, rollback interaction. |
| `webhooks.md` | Endpoint inventory (Stripe/Razorpay/WhatsApp/Email paths, secret vars, rate limits), per-env registration (local simulator → staging TEST-mode signed traffic → production LIVE cutover as config change), rotation reusing the s-10/s-30 runbooks. |
| `crons.md` | Inventory table (owner, schedule, idempotency), runner semantics, per-job observability (logs + the two metrics counters, s-34 absence-alert hook), platform-scheduler alternative, verification mapping to tests. |
| `rollback.md` | Four principles (forward-only, N/N+1, verify-then-redeploy, PITR last resort), step-by-step procedure for both envs, when rollback is NOT the answer, PITR procedure, and the drill log with the s-33 evidence row. |

---

## 8. Startup self-check tests

`apps/backend/src/tests/startup-config.test.ts` (5 tests) pins the two
contracts CI and operators rely on:

1. `apiConfig({})` / `workerConfig({})` throw `ConfigValidationError`
   LISTING `DATABASE_URL`, `REDIS_URL`, `TEMPORAL_ADDRESS` — the same
   loud-fail the entrypoint performs one layer out.
2. `MOCK_PROVIDERS=false` without keys names all nine provider keys.
3. `POST /demo/payment-fail` is **404** on a production + `MOCK=false` app
   (routes omitted at registration, not merely guarded).
4. The same route is NOT 404 on a mock-mode app (registration present;
   anonymous call gets 401 from `demoGuard` → auth, proving presence).

---

## 9. Problems discovered during verification and their fixes

### 9.1 Repeated full-suite runs poison shared Redis (self-inflicted, triaged)

Symptom: after several full `vitest run --project unit` invocations,
`webhooks.test.ts` (9 failures) and `messaging-integration.test.ts` went
red with `expected 429 to be 401/200` — the s-30 signature-abuse IP block
(`IpBlockService`: 10 verification failures / 10min → 10min `429
IP_BLOCKED`) had tripped for `127.0.0.1` in the persistent local Redis,
because every run's invalid-signature probes accumulate in the SHARED
`db 0` keyspace. It looked like a regression; it was environmental state.

Fix: `FLUSHALL` on local Redis → `webhooks.test.ts` 11/11 green
immediately. No code changed. Lessons recorded where they matter: the CI
workflow header mandates fresh service containers per job (never share
Redis between suites), and the progress log notes the triage. This is the
same leak class s-32 fixed for e2e with `db-1` isolation — unit/integration
suites still share `db 0` locally, which is fine for single runs but not
for rapid repeats without a flush.

### 9.2 E2E worker compose referenced a Dockerfile that does not exist

`tests/e2e/setup/compose.e2e.yml` built its worker from
`services/worker/Dockerfile` — no such file exists in the repo, so the
composed e2e profile could never build its worker. Fixed by building the
unified production image in worker mode (which is also the step's
identical-image requirement), disabling the HTTP healthcheck, and adding
the missing `temporal` dependency.

### 9.3 `deploy-check` false positive on its own documentation

The worker-healthcheck scan split compose files into service blocks but
matched `command: ["worker"]` inside the header COMMENT (which documents
the pattern), flagging a violation in a comment. Fixed by stripping
full-line comments before block analysis — and it is a good reminder that
linters must parse structure, not substrings, where comments echo code.

### 9.4 An edit dropped `SESSION_SECRET` from the config schema (caught immediately)

A mis-scoped string replacement in `packages/config/src/env.ts` removed the
`SESSION_SECRET` default along with adjacent lines. Caught by diffing
(`git diff` showed the loss), repaired, and re-verified with an empty diff
before proceeding. Recorded here as process evidence: every edit to shared
schema files was followed by a diff review in this step.

---

## 10. Verification evidence (Definition of Done)

| DoD item | Evidence |
|---|---|
| CI green incl. e2e gate | Pipeline declared end-to-end in `ci.yml` (11 stages incl. e2e + coverage audit); locally: `check-types` 12/12 pkgs green, `lint` green, `check-docs` 66 links OK, targeted suites 32/32 green (`packages/config` incl. 5 new cron tests, backend scheduler 5, worker scheduler 4, startup-config 5). Full unit suite triaged per 9.1 (environmental, not a regression). Live CI execution happens on first push (no GitHub remote from this environment). |
| Staging live w/ signed webhooks | Operator step at first deploy: `deploy-staging.yml` + `webhooks.md` §2 (TEST-mode registration, per-provider verification, forged-signature 401 check). No staging account is reachable from this environment; the runbook is execution-ready. |
| Demo scenario on staging | Documented time-boxed drill (`environments.md` rule 3): redeploy `MOCK_PROVIDERS=true` → simulator → redeploy prod-shape → smoke re-verifies `/demo` 404. Prod-shape 404 proven in-process (startup-config test); mock-shape presence proven the same way. |
| Migration via pipeline + gate proven | `migrate` job in `deploy-staging.yml` (DIRECT_URL, then `migrate:check`); gate proven BOTH ways against a scratch local DB: `migrate:check` on empty DB → `❌ 10 pending, exit 1`; after `db:migrate` → `✅ 10/10 applied` (scratch DB dropped afterwards). |
| Rollback drill documented | `rollback.md` procedure + drill log row: compat-gate flag enforcement verified (`ROLLBACK_TAG` missing → fail; `CONFIRM_SCHEMA_COMPAT` unset → fail); post-rollback smoke = same script. Live previous-tag redeploy is the operator step at first staging deploy. |
| Cron inventory live + observable | Backend 4 jobs + worker scheduler wired behind `CRON_*` config; unit tests green (cadence, overlap-skip, failure-continues, stop, per-tenant aggregation/error-continuation); pass/completion log lines specified in `crons.md` §2 with metric counters; s-34 owns absence alerts. |
| Image smoke (step §Tests) | Entrypoint executed via `sh`: `api`/`worker` with empty env → `FATAL: missing required config: DATABASE_URL REDIS_URL TEMPORAL_ADDRESS TEMPORAL_NAMESPACE`, exit 2; unknown mode → usage error, exit 2. Same assertions run in CI `build` against the built image. |
| Staging smoke (step §Observability) | `smoke-staging.mjs` 6/6 green against the local stack (`/health`, `/ready` with `db+redis up`, `/version`, `/metrics`, `/cases` 401-negative, demo-shape report in non-strict mode). |

Repo-wide gates: `bun run check-types` 12/12 · `bun run lint` green ·
`bun run check-docs` 66 links OK · `bun run deploy:check` PASS.

---

## 11. Deviations and judgment calls

1. **No new `DEMO_ROUTES_ENABLED` toggle.** The DoD's "staging temporary
   toggle" is satisfied WITHOUT code: redeploying staging with
   `MOCK_PROVIDERS=true` re-registers `/demo/*` automatically (the omission
   condition is `production AND mock=false`), and `demoGuard` passes in mock
   mode. One fewer env var, one fewer bypass to audit — documented in
   `environments.md` rule 3.
2. **Worker joins compose behind a `worker` profile** instead of the default
   stack, so `bun run infra:up` behavior is unchanged for existing flows;
   the full local loop is one flag away. Default-on would have been nicer
   for Temporal newcomers, but untestable-from-here default changes to
   everyone's boot path are the wrong trade.
3. **Cron runs in-process** (API + worker) rather than on a platform
   scheduler or Temporal Schedules: zero new infrastructure, intervals as
   config, idempotent + overlap-guarded jobs. The platform mapping is
   documented 1:1 for the HA cutover (`crons.md` §3).
4. **Twins, not moves, for Dockerfiles.** The canonical images are the
   step-mandated `infra/docker/*` paths; `apps/*/Dockerfile` carry identical
   bodies because compose files, READMEs, and the s-30 audit script
   referenced them. `deploy-check` fails on drift; the next step that
   touches those references may delete the twins.
5. **`services/worker/Dockerfile` was NOT created** — the dead reference now
   points at the unified image instead. One image, fewer files to rotate.
6. **CI references `vars.STAGING_PUBLIC_API_URL` and secret names that don't
   exist yet** — they are provisioned when the staging account is created
   (checklist in `environments.md`); the workflow fails closed with clear
   messages until then.
7. Nothing else was touched: no spec files modified besides
   `specs/steps/progress.md`, no application behavior changed outside the
   cron wiring + boot log line, and the pre-existing s-32 working-tree
   changes were left exactly as found.
