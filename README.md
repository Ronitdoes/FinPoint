# FinPoint — Autonomous-but-Bounded Revenue Recovery Platform

> **Thesis:** *AI decides what should happen; policy + workflow infrastructure decide what is allowed to happen.*
>
> A **revenue operating system for recovery** — not "an LLM that sends reminders." It closes the loop
> `Detection → Decision → Policy → Execution → Outcome → Learning` for every rupee at risk.

**Stack:** Bun ≥ 1.4 · Fastify 5 · Next.js 16 / React 19 · PostgreSQL 16 + Drizzle ORM · Temporal · Redpanda/Kafka · Redis 7 · OpenTelemetry + Prometheus + Pino · Vitest · Turbo
**Demo:** fresh clone → `infra:up` → `db:migrate` → `db:seed --reset` → dashboard populated → `/demo/*` drives real recovery end-to-end.
**Release:** v0.1.0 signed off in [`docs/RELEASE-v0.1.0.md`](./docs/RELEASE-v0.1.0.md) (DoD 18/18, known limitations L1–L6, deferral register). Changelog: [`CHANGELOG.md`](./CHANGELOG.md).

---

## Table of Contents

- [1. What This Is](#1-what-this-is)
- [2. Features (MVP Matrix)](#2-features-mvp-matrix)
- [3. Architecture](#3-architecture)
- [4. Repository Layout](#4-repository-layout)
- [5. Tech Stack](#5-tech-stack)
- [6. Prerequisites](#6-prerequisites)
- [7. Quickstart (5 Minutes to Demoable)](#7-quickstart-5-minutes-to-demoable)
- [8. Environment Configuration](#8-environment-configuration)
- [9. Running the System](#9-running-the-system)
- [10. API Reference](#10-api-reference)
- [11. Core Domain Rules (Read Before Coding)](#11-core-domain-rules-read-before-coding)
- [12. Recovery Workflows (A/B/C) + Orchestration + Human Approvals](#12-recovery-workflows-abc--orchestration--human-approvals)
- [13. AI Decision Service + Governance + Eval Harness](#13-ai-decision-service--governance--eval-harness)
- [14. Dashboard (`apps/frontend`)](#14-dashboard-appsfrontend)
- [15. Demo Mode, Simulation & Seed Data](#15-demo-mode-simulation--seed-data)
- [16. Observability](#16-observability)
- [17. Security, Auth & Tenant Isolation](#17-security-auth--tenant-isolation)
- [18. Testing](#18-testing)
- [19. Database](#19-database)
- [20. Roadmap & Implementation Order](#20-roadmap--implementation-order)
- [21. Documentation Index](#21-documentation-index)
- [22. Contributing & Agent Workflow](#22-contributing--agent-workflow)
- [23. Verification Commands](#23-verification-commands)
- [24. Troubleshooting](#24-troubleshooting)
- [25. Explicitly Out of Scope (Post-MVP)](#25-explicitly-out-of-scope-post-mvp)

---

## 1. What This Is

Revenue leakage is fragmented across **payment failures, subscription/churn billing failures, checkout abandonment, overdue invoices, failed mandates/method-updates, promise-to-pay no-shows, and support/revenue cases falling between teams**. The typical system is a dashboard alert + a manual notice. This system is a **closed recovery loop**:

```text
Payment failed → Risk detected → Context assembled → Intervention selected
  → Policy checked → Workflow executes → Customer responds → Stop / Escalate
  → Recovered amount measured → Dashboard + Audit prove it
```

Two pillars (from `specs/00-brainstorm-and-product-vision.md`):

| Pillar | Meaning |
|---|---|
| **A — Revenue intelligence** | What/why is at risk, how recoverable it is, automation vs. human triage. Implemented by Risk Engine (`s-12`), Context Service (`s-13`), Analytics (`s-27`). |
| **B — Bounded autonomy** | AI recommends; it **cannot** bypass spending/communication/discount limits, approvals, opt-outs, disputes, or stop conditions. Enforced structurally by Policy Engine (`s-16`), guarded writes (`s-06`), workflow determinism (`s-20`), covered in `s-30`–`s-32`. |

Architectural contract (enforced at every review, see `docs/ARCHITECTURE.md` §3):

> `AI = recommendation + interpretation · Policy = permission · Temporal = execution + durability · PostgreSQL = source of truth · Event bus = async propagation · Adapters = provider-specific execution · Dashboard = observation`

No component silently takes over another layer's responsibility.

---

## 2. Features (MVP Matrix)

Source: `specs/03-mvp-build-spec.md` §1, tracked in `docs/TRACEABILITY.md` §1. Each row is implemented by the listed step.

| # | Feature | MVP | Implemented by |
|---|---|---|---|
| 1 | Payment webhooks (Stripe + Razorpay, HMAC, dedupe, store, publish) | Yes | `s-10` |
| 2 | Razorpay / Stripe payment adapter | Yes | `s-18` (`packages/integrations/payments`) |
| 3 | Risk scoring (deterministic weighted rules + bands) | Rule-based | `s-12` |
| 4 | Customer context (allowlists, size limits, tenant isolation) | Yes | `s-13` |
| 5 | LLM decisioning (risk + context → structured recommendation) | Yes | `s-14` |
| 6 | Structured output (JSON Schema enforced, ADR-008) | Yes | `s-14`, eval `s-15` |
| 7 | Policy engine (deterministic hard rules) | Yes | `s-16` (9 seeded rules) |
| 8 | Temporal durable workflows | Yes | `s-20` foundation; `s-22`–`s-24` workflows |
| 9 | WhatsApp adapter (or mocked adapter) | Yes / mocked | `s-19`, mock variant `s-29` |
| 10 | Email adapter + delivery ledger | Yes | `s-19` |
| 11 | Checkout abandonment (Workflow B) | Yes | `s-23` |
| 12 | Overdue invoices (Workflow C) | Yes | `s-24` |
| 13 | Promise-to-pay (within Workflow C) | Yes | `s-24` |
| 14 | Human escalation (signal-based waits) | Yes | `s-21` |
| 15 | Audit trail (immutable timeline) | Yes | `s-25` |
| 16 | Dashboard (overview, funnel, interventions, case detail) | Yes | `s-28` |

Supporting infrastructure: local infra + config (`s-02`), domain package (`s-03`), financial schema (`s-04`), recovery schema (`s-05`), migrations/repositories (`s-06`), API skeleton (`s-07`), observability (`s-08`), auth (`s-09`), event bus + replay (`s-11`), orchestration pipeline (`s-17`), outcomes/attribution/cost (`s-26`), analytics APIs (`s-27`), demo/seed (`s-29`).

The 18-item Definition of Done (`spec 01` §29 → `docs/TRACEABILITY.md` §2) flows headlessly through `s-10`…`s-28` and is covered as E2E acceptance tests in `s-32`.

---

## 3. Architecture

### 3.1 System diagram

From `docs/ARCHITECTURE.md` §2 (adapted from spec 01 §0, annotated with repo paths):

```text
                 ┌─────────────────────────────┐
                 │ Stripe / Razorpay           │
                 │ Checkout / Billing          │
                 │ ERP / CRM                   │
                 └──────────────┬──────────────┘
                                ▼
                 ┌─────────────────────────────┐
                 │ Fastify Event Gateway       │   apps/backend
                 │ auth + validation           │   modules/webhooks, modules/events
                 │ idempotency                 │   plugins/{authn,rateLimit}  (s-07..s-10)
                 └──────────────┬──────────────┘
                                ▼
                 ┌─────────────────────────────┐
                 │ EventBus                    │   Redpanda topic revenue-events.v1 (s-11)
                 │ Kafka / Redpanda ⇄ inproc   │   or in-process fallback (ADR-006)
                 └──────────────┬──────────────┘
          ┌─────────────────────┼─────────────────────┐
          ▼                     ▼                     ▼
   Risk Engine          Context Service         Analytics      apps/backend
   modules/risk         modules/customers       modules/analytics, s-12/s-13/s-27
                                                     outcomes from packages/db
          │                     │
          └──────────┬──────────┘
                     ▼
          ┌─────────────────────┐
          │ AI Decision Service │   apps/backend/modules/ai             (s-14)
          │ structured outputs  │   prompts/, schemas/ (ADR-008)
          └──────────┬──────────┘
                     ▼
          ┌─────────────────────┐
          │ Policy Engine       │   packages/policy + modules/policy    (s-16)
          └──────────┬──────────┘
                     ▼
          ┌─────────────────────┐
          │ Temporal            │   services/worker                      (s-17, s-20..s-24)
          │ Durable Workflows   │   namespace revenue-recovery,
          │                     │   queue recovery-main (ADR-005)
          └──────────┬──────────┘
       ┌─────────────┼──────────────────┐
       ▼             ▼                  ▼
 Payment Adapter  Messaging Adapter  Human Escalation
 packages/        packages/          modules/cases + human tasks   (s-18,s-19,s-21)
 integrations/    integrations/
 payments         messaging
       │             │                  │
       └─────────────┼──────────────────┘
                     ▼
          ┌─────────────────────┐
          │ PostgreSQL          │   packages/db — schema, repositories,  (s-04..s-06)
          │ source of truth     │   migrations (ADR-003/004)
          │ outcomes + audit    │
          └──────────┬──────────┘
                     ▼
          ┌─────────────────────┐
          │ Next.js Dashboard   │   apps/frontend/src/app/(dashboard)/... (s-28)
          └─────────────────────┘

   Cross-cutting: packages/config (env, s-02) · packages/domain (vocabulary, s-03)
                  packages/observability (otel/logging/metrics, s-08)
                  infra/docker · infra/temporal · infra/grafana (s-02, s-08, s-34)
```

### 3.2 Component responsibility table

| Component | Responsibilities | Does NOT | Location | Step(s) |
|---|---|---|---|---|
| **Event Gateway** | Receive webhooks; authenticate; normalize; enforce idempotency; publish internal events | Call LLMs; run long workflows; message customers | `apps/backend/src/modules/webhooks`, `modules/events`; `src/plugins` | `s-07`, `s-09`–`s-11` |
| **Risk Engine** | Detect financial risk; deterministic score; risk type; severity; risk records | Message customers; issue discounts; bypass policy | `apps/backend/src/modules/risk`; rules in `packages/domain` | `s-12` |
| **Customer Context Service** | Aggregate approved context; summarize history; field allowlists; tenant boundaries | Decide actions | `apps/backend/src/modules/customers` | `s-13` |
| **AI Decision Service** | Diagnose cause; rank approved interventions; draft template content where allowed; structured output | Call Stripe/Razorpay; message customers; bypass policy | `apps/backend/src/modules/ai` | `s-14`, `s-15` |
| **Policy Engine** | Enforce hard limits; approve/reject; require human approval; contact frequency; stop conditions | Trust LLM output without validation | `packages/policy` + `modules/policy` | `s-16` |
| **Workflow Engine (Temporal)** | Timers; retries; durable state; compensation; human waits; lifecycle | Run business decisions inline (delegates to activities) | `services/worker` | `s-20`, `s-22`–`s-24` |
| **Integration Layer** | Payment / Messaging adapters, explicit interfaces, idempotent ops; credentials confined here | Leak provider specifics into orchestration | `packages/integrations/payments`, `.../messaging` | `s-18`, `s-19` |
| **Human Escalation** | Human tasks; wait on Temporal signals for approve/reject/pause/resume | Auto-resolve without policy basis | `apps/backend/src/modules/cases` + worker activities | `s-21` |
| **Outcomes & Attribution** | Authoritative outcome rows; recovered amount, cost, attribution | Derive money from UI state | `apps/backend/src/modules/analytics` via `packages/db` | `s-26`, `s-27` |
| **Dashboard** | Observation only: cases, risk, recovery metrics, policies, audit timeline | Compute business state client-side | `apps/frontend/src/app/(dashboard)/...` | `s-28` |
| **Demo / Simulation** | Mock providers + simulation endpoints proving the loop without real money | Touch live providers when mock mode is on | `apps/backend/src/modules/demo`; mocks in `packages/integrations` | `s-29` |

### 3.3 Spec ↔ repo naming map

Spec documents use different folder names. **Repo names are canonical — do not rename** (`docs/ARCHITECTURE.md` §1):

| Spec name | Repo path (canonical) | Role |
|---|---|---|
| `apps/api` | `apps/backend` | Fastify event gateway + internal REST APIs |
| `apps/web` | `apps/frontend` | Next.js dashboard |
| `services/ai-decision` | `apps/backend/src/modules/ai` | Collapsed into backend (spec 01 §2 allows collapsing for MVP) |
| `services/risk-engine` | `apps/backend/src/modules/risk` + consumer wiring | Collapsed into backend |
| `services/worker` | `services/worker` | Temporal worker |

Shared code always lives in `packages/*` regardless of importer.

---

## 4. Repository Layout

Target layout (`docs/ARCHITECTURE.md` §4). The `s-01` gap review assigns every gap an owner step.

```text
AI-Revenue-Recovery/
├── apps/
│   ├── backend/                  # Fastify Event Gateway + internal REST APIs
│   │   ├── Dockerfile            # oven/bun:1.4-alpine, port 4000, non-root appuser:1001
│   │   ├── scripts/              # seed-admin.ts (5 personas), seed-policies.ts
│   │   └── src/
│   │       ├── app.ts            # buildApp() factory — 10 plugins + route registry + 2 consumers
│   │       ├── server.ts         # listen + graceful shutdown (25s deadline, 20s in-flight drain)
│   │       ├── index.ts          # re-exports
│   │       ├── lib/              # routes.ts registry, errors.ts envelope, crypto.ts
│   │       ├── plugins/          # auth, rbac, context, cors, rate-limit, db,
│   │       │                     # error-handler, logger, otel, shutdown (10 total)
│   │       ├── modules/          # 18 domain modules (see below)
│   │       └── tests/            # 19 integration test files
│   └── frontend/                 # Next.js 16 dashboard (standalone output)
│       ├── src/app/              # / (→/dashboard), /(auth)/login, /(dashboard)/{dashboard,cases,
│       │                         #   cases/[id],risk,recovery,policies,tasks,audit,settings}
│       ├── src/lib/              # api.ts (767-line typed client), rbac.ts, types.ts, money.ts
│       ├── src/components/       # ui/, cases/, charts/ (recharts), modals/, timeline/, cards/
│       ├── src/middleware.ts     # rr_session cookie guard
│       └── Dockerfile            # bun build → node:20-alpine runner, :3000
├── services/
│   ├── worker/                   # Temporal worker (@repo/worker): workflows/ + activities/
│   │   └── src/                  # workflows/ (5), activities/ (22), signaling/ (3 bridges),
│   │                             # framework/ (retry policies, errors), cron/ (DailyReconciler)
│   └── eval/                     # Offline LLM eval harness (@repo/eval): run.ts, runner.ts,
│                                 # datasets/golden-v1.json (~994 lines, 30 cases)
├── packages/
│   ├── config/                   # @repo/config — ONLY place process.env is read (zod, frozen)
│   ├── domain/                   # @repo/domain — pure truth: enums, entities, state machines,
│   │                             # event envelope, action catalog (zod only, no I/O)
│   ├── db/                       # @repo/db — Drizzle schema (33 tables + 6 views),
│   │                             # 11 migrations, 28 repos, seeds (factories/scenarios/reset)
│   ├── policy/                   # @repo/policy — pure evaluator + 9 compiled rules
│   ├── integrations/             # @repo/integrations — payments/, messaging/, events/
│   │                             # (Stripe/Razorpay/Mock, WhatsApp/Email/Mock, InProcess/Redpanda)
│   ├── observability/            # @repo/observability — Pino logger, OTel tracing, prom-client metrics
│   ├── orchestration/            # @repo/orchestration — DB-backed workflow client (recover:{caseId})
│   ├── testing/                  # @repo/testing — defineFixtureFactory<T> helper
│   ├── eslint-config/            # base.js, next.js, react-internal.js, worker.js (determinism guard)
│   └── typescript-config/        # base.json (strict), nextjs.json, react-library.json
├── infra/
│   ├── docker/                   # docker-compose.yml (9 services), otel-collector-config.yaml, .env
│   ├── temporal/                 # dynamicconfig.yaml
│   └── grafana/                  # provisioning/ (datasources + dashboards stubs), README
├── docs/                         # ARCHITECTURE, CONVENTIONS, TRACEABILITY, adr/ (14),
│                                 # explanation/ (28 step explainers), runbooks/, demo-script.md,
│                                 # attribution.md, audit-field-contract.md, PROMPT_EVALUATION.md
├── specs/                        # Source of truth (DO NOT EDIT except steps/progress.md)
│   ├── 00-brainstorm-and-product-vision.md / 01-implementation-0-to-100.md
│   ├── 02-architecture-and-domain.md / 03-mvp-build-spec.md
│   └── steps/                    # s-01…s-35 (each: objectives, contracts, tests, DoD) + progress.md
├── scripts/check-docs-links.mjs  # bun run check-docs
├── turbo.json / vitest.config.ts / bunfig.toml / package.json
└── .env.example                  # Full env template (see §8)
```

**Backend modules (18):** `admin` (users, api-keys) · `ai` (+ `governance/`, `llm/`, `prompts/`, `schemas/`, `validate/`) · `analytics` (+ `queries/`) · `audit` · `auth` · `cases` (pipeline/creation/control/consumer) · `customers` (+ `context/`) · `demo` (simulator, injections) · `events` (replay) · `human-tasks` (SLA sweeper) · `messaging` (+ `webhooks/whatsapp`, `webhooks/email`) · `meta` (health/ready/version) · `outcomes` (record, attribution sweeper, cost job) · `payments` (execution, refresh) · `policy` · `promises-to-pay` · `risk` (+ `engine/`) · `webhooks` (+ `normalize/stripe,razorpay,unmapped`).

---

## 5. Tech Stack

| Layer | Choice | Why / where decided |
|---|---|---|
| Runtime / PM | **Bun ≥ 1.4** (`bun install` only) | ADR-001 |
| HTTP framework | **Fastify 5** on Bun (`buildApp` factory) | ADR-002 |
| Dashboard | **Next.js 16.3.2**, React 19.2.8, Tailwind 4, Recharts 3, Lucide, GSAP | `apps/frontend/package.json` |
| Database | **PostgreSQL 16** (Neon / Lakebase-compatible) + **Drizzle ORM** via pooled `postgres.js` | ADR-003 |
| Migrations | Forward-only Drizzle Kit SQL via `migrate.ts` (+ advisory lock `724193`, `--check` CI) | ADR-004 |
| Workflows | **Temporal** self-hosted locally, namespace `revenue-recovery`, queue `recovery-main` | ADR-005 |
| Event streaming | **Redpanda** topic `revenue-events.v1` behind `EventBus` interface + **in-process fallback** (`EVENT_BUS_DRIVER=inprocess\|redpanda`) | ADR-006 |
| Cache / locks / rate-limit | **Redis 7** (`ioredis`): 60s session/API-key hot path, 30s context + analytics cache, rate buckets, idempotency fast path | ADR-007 |
| LLM access | **OpenAI-compatible client**, schema-enforced structured outputs, no tool-calling | ADR-008 |
| Money | Integer minor units (paise/cents) + ISO-4217, never floats | ADR-009 |
| Identifiers | UUIDv4 PKs, bigserial log ordering, `RC-{per-tenant-seq}` display-only case numbers | ADR-010 |
| Time | UTC `timestamptz`, ISO-8601 APIs, tenant-timezone day math in utilities only | ADR-011 |
| AuthN/Z | Sessions (`rr_session`) + API keys (`rrk_*`), 5 roles, mandatory tenant guard | ADR-012 |
| Test runner | **Vitest** primary (workspace); `bun test` only for pure domain units | ADR-013 |
| Observability | **OTel tracing** + **Prometheus** metrics + **Pino** JSON logging | ADR-014 |
| Monorepo | **Turbo** (`turbo run build|dev|lint|check-types`), workspaces `apps/*, packages/*, services/*` | `turbo.json` |
| Validation | **Zod** everywhere (env, envelopes, catalog params, API schemas) | CONVENTIONS |

---

## 6. Prerequisites

- **Bun ≥ 1.4.0** (runtime + package manager — do not use npm/yarn/pnpm)
- **Docker + Docker Compose** (for `infra:up`: Postgres, Redis, Temporal, Redpanda, collector, app images)
- **Git**, a POSIX-style shell (repo scripts assume POSIX paths even on Windows; run from repo root)
- Optional: **Node ≥ 18** (engines field; frontend runner image is `node:20-alpine`), `tctl`/`temporal` CLI for namespace inspection
- Ports free: `3000` (frontend) · `4000` (backend) · `5432` (PG) · `6379` (Redis) · `7233` (Temporal) · `8080` (Temporal UI) · `8081` (Redpanda console) · `9092` (Redpanda) · `4317/4318/8888` (OTel)

---

## 7. Quickstart (5 Minutes to Demoable)

Fresh clone → compose → seed → dashboard populated → simulator drives real recovery.
Ten commands, in order (run from repo root):

```bash
git clone <repo-url> AI-Revenue-Recovery            # 1. clone
cd AI-Revenue-Recovery && bun install              # 2. install (Bun only)
cp .env.example .env                               # 3. configure (MOCK_PROVIDERS=true is enough for demo)
bun run infra:up                                   # 4. start infra (postgres, redis, temporal, redpanda, collector, backend, frontend)
bun run db:migrate                                 # 5. apply all 11 migrations
bun run db:seed --reset                            # 6. seed volumes + Scenarios A/B/C (prints determinism hash)
bun --filter @repo/worker start                    # 7. start Temporal worker (required for workflow execution scenes)
bun --filter backend dev                           # 8. (if backend not via compose) Fastify :4000 — skip if composed
# 9. open http://localhost:3000 → /dashboard (ops@example.com / Admin12345!@#)
curl -X POST http://localhost:4000/demo/payment-fail \  # 10. drive the loop (Scenario A, CUS-001, ₹12,999)
  -H 'Content-Type: application/json' -H 'Authorization: Bearer <rrk_...>' \
  -d '{"scenario":"A"}'
```

Notes: `bun run infra:up:build` rebuilds images · `bun run infra:down` tears down ·
`db:migrate:check` is the CI pending-migration gate · `db:seed --reset` is
slug-guarded (demo tenants only) and atomic since v0.1.0 (see
`docs/RELEASE-v0.1.0.md` F1). The default compose profile does **not** start a
worker — command 7 (or `docker compose --profile worker up -d worker`) is
required before workflow-execution scenes. Tear down the host worker with Ctrl-C.

**Drive the loop (no real money — `MOCK_PROVIDERS=true`):**

```bash
# Fail a payment for pristine Scenario A customer (CUS-001, ₹12,999, Stripe HMAC loopback)
curl -X POST http://localhost:4000/demo/payment-fail \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer <rrk_...>' \
  -d '{"scenario":"A"}'

# Watch: Risk 86/100 HIGH → AI insufficient_funds → Policy ALLOWED →
#        Temporal recover:<caseId> WAIT→MESSAGE→RETRY → dashboard updates

# Close the loop
curl -X POST http://localhost:4000/demo/payment-succeed -H 'Authorization: Bearer <rrk_...>' \
  -d '{"scenario":"A"}'
# → external-payment-succeeded signal → case RECOVERED → outcome + audit timeline
```

Full 9-scene narrative: [`docs/demo-script.md`](./docs/demo-script.md) (3–5 min: Baseline → Trigger → Case → AI → Policy → Orchestration → Success → ROI → Audit).

---

## 8. Environment Configuration

`packages/config` is the **only** place `process.env` is read. Everything else consumes frozen typed presets (`apiConfig` / `workerConfig` / `webConfig`); startup is **fail-fast** on invalid env. Copy `.env.example` → `.env` (`.env` is gitignored; secrets never enter code, logs, or git).

| Group | Key vars | Notes |
|---|---|---|
| App & server | `NODE_ENV`, `PORT`, `LOG_LEVEL` | Compose backend serves `:4000`; `PORT` default in example is `8000` — compose overrides to `4000`. Frontend default API base `http://localhost:4000`. |
| Frontend (public) | `NEXT_PUBLIC_API_URL` | Belongs in `apps/frontend/.env.local` (inlined at Next build time). |
| Postgres | `DATABASE_URL` (pooled, `-pooler` host on Neon), `DIRECT_URL` (unpooled DDL/migrations) | Local default `postgres://postgres:postgres@localhost:5432/revenue_recovery`. |
| Redis / Temporal / Bus | `REDIS_URL`, `TEMPORAL_ADDRESS/NAMESPACE/TASK_QUEUE`, `EVENT_BUS_DRIVER=inprocess\|redpanda`, `REDPANDA_BROKERS` | Namespace `revenue-recovery`, queue `recovery-main`, topic `revenue-events.v1`. |
| Auth & bootstrap | `SESSION_SECRET`, `BOOTSTRAP_ADMIN_EMAIL/PASSWORD/NAME/TENANT_NAME` | Seeds 5 personas via `scripts/seed-admin.ts`. |
| AI / LLM | `LLM_API_KEY`, `AI_MODEL=gpt-4o`, `LLM_BASE_URL`, `LLM_TIMEOUT_MS=20000`, `LLM_MAX_RETRIES=2` | Not needed for demo (mock + fallback). |
| Payments | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RAZORPAY_KEY_ID/KEY_SECRET/WEBHOOK_SECRET` | Required at startup **only** when `MOCK_PROVIDERS=false`. |
| Messaging | `WHATSAPP_API_KEY/PHONE_NUMBER_ID/VERIFY_SECRET`, `EMAIL_API_KEY/FROM/WEBHOOK_SECRET` | Same fail-fast rule as payments. |
| Demo & chaos | `MOCK_PROVIDERS=true`, `SIMULATE_PAYMENT_TIMEOUT/MESSAGE_FAILURE/LLM_FAILURE/DUPLICATE_WEBHOOK` | Mock mode + 4 failure-injection switches (spec 03 §9; Redis-backed 15m TTL overrides via `/demo/injections`). |
| Observability | `OTEL_EXPORTER_OTLP_ENDPOINT` | Empty = local-only; collector listens `:4317/:4318`. |

---

## 9. Running the System

Root scripts (`package.json` — all from repo root):

| Command | What it does |
|---|---|
| `bun run dev` | `turbo run dev` — watch mode for all apps/services |
| `bun run build` / `start` | `turbo run build` / `start` |
| `bun run check-types` | `turbo run check-types` — **must pass before finishing any step** |
| `bun run lint` | `turbo run lint` (backend + worker have lint configs) |
| `bun run test` | `vitest run` (workspace; see §18) |
| `bun run check-docs` | `bun scripts/check-docs-links.mjs` — after editing any `docs/*.md` |
| `bun run format` | Prettier `**/*.{ts,tsx,md}` |
| `bun run db:migrate` / `db:migrate:check` / `db:seed` | Via `@repo/db`: migrate, CI pending-check, seed demo data |
| `bun run infra:up` / `infra:up:build` / `infra:build` / `infra:down` | Compose `infra/docker/docker-compose.yml` lifecycle |

Per-entrypoint:

```bash
bun --filter backend dev        # bun --watch src/server.ts  (:4000)
bun --filter backend start      # bun src/server.ts
bun --filter @repo/worker dev   # Temporal worker (recovery-main)
bun --filter frontend dev       # next dev (:3000)
bun --filter @repo/eval run:eval -- --mock   # LLM eval harness (CI gate)
```

Docker images: `infra/docker/backend.Dockerfile` (unified API+worker image, multi-stage `oven/bun:1.4-alpine`, non-root, entrypoint modes `api`/`worker`/`migrate`), `infra/docker/frontend.Dockerfile` (`NEXT_PUBLIC_API_URL`-only build-arg → `node:20-alpine` standalone runner). Identical twins kept at `apps/backend/Dockerfile` + `apps/frontend/Dockerfile` (see `docs/deploy/`).

---

## 10. API Reference

Base URL autodetects `NEXT_PUBLIC_API_URL`, default `http://localhost:4000`. Global: body limit **256 KB** (`413`), raw-body-preserving JSON parser, canonical error envelope (see §11.4), `404` handler, global rate limit **1000/min** (`rr:global:ratelimit:`), W3C `traceparent` + `x-correlation-id` echoed. `/demo/*` omitted in prod (`MOCK_PROVIDERS=false` → `410 MOCK_DISABLED`).

### 10.1 Meta (public)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health`, `/api/health` | Liveness |
| `GET` | `/ready` | Readiness (5s cache; checks DB/Redis) |
| `GET` | `/version` | Build version |
| `GET` | `/metrics` | Prometheus exposition (15+ `arr_*` families) |
| `GET` | `/`, `/api` | Index |

### 10.2 Auth (`/auth`) + Admin (`/admin`, ADMIN-only)

| Method | Path | Auth |
|---|---|---|
| `POST` | `/auth/login` | Public (IP+email 5/min + lockout; sets `rr_session` httpOnly, 12h sliding) |
| `POST` | `/auth/logout` | `requireAuth` |
| `GET` | `/auth/me` | `requireAuth` |
| `POST` | `/admin/users` (201) | ADMIN |
| `PATCH` | `/admin/users/:id` | ADMIN |
| `GET` | `/admin/users` | ADMIN |
| `POST` | `/admin/api-keys` (201, raw `rrk_*` returned once) | ADMIN |
| `DELETE` | `/admin/api-keys/:id` (204, revocation) | ADMIN |
| `GET` | `/admin/api-keys` | ADMIN |

### 10.3 Webhooks (HMAC-only, NO session/API key)

All enforce `Content-Type: application/json` else `406`; per-route **600/min**.

| Method | Path | Verification |
|---|---|---|
| `POST` | `/webhooks/stripe` | `Stripe-Signature` HMAC, ±5m window, `?tenant_id` |
| `POST` | `/webhooks/razorpay` | `x-razorpay-signature` HMAC-SHA256 |
| `GET` | `/webhooks/whatsapp` | Meta `hub.mode/verify_token/challenge` handshake (public) |
| `POST` | `/webhooks/whatsapp` | `x-hub-signature-256` (401 in prod); status receipts + inbound; STOP keyword → opt-out + `customer.opted_out` event |
| `POST` | `/webhooks/email`, `/webhooks/email/:token` | `x-webhook-token` / Bearer vs secret |

Rotation runbook: `docs/runbooks/webhook-secrets-rotation.md` (zero-downtime Stripe dual-`v1`, Razorpay single-secret).

### 10.4 Core domain

| Prefix | Method + Path | RBAC / notes |
|---|---|---|
| `/events` | `POST /events` (202) | Scope `events:write`; `tenant_id == auth.tenant`; `Idempotency-Key` 24h; 60/min |
| | `POST /events/replay` (202) | `OPERATIONS, FINANCE, ADMIN`; `replayed_from` linking + audit log |
| `/risks` | `GET /risks?status&band&risk_type&customer_id&from&to&limit&cursor` | Any authenticated |
| | `GET /risks/:id` | Any authenticated (strict tenant isolation) |
| `/customers` | `GET /customers/:id/context?purpose=ai_decision\|api_read&fresh` (+ `X-Context-Built-At/Bytes`) | All 5 roles |
| `/ai` | `POST /ai/decide {case_id, risk_id?, purpose}` | Scope `ai:decide`; 24h Idempotency-Key |
| | `GET /ai/decisions?case_id&status&limit&offset&include=input_snapshot[ADMIN]` | `OPERATIONS, FINANCE, ADMIN` (snapshot masked otherwise) |
| | `GET /ai/decisions/:id` | `OPERATIONS, FINANCE, ADMIN` |
| `/policy` | `POST /policy/evaluate` | Custom: API key `policy:evaluate\|worker\|*` OR session `OPERATIONS+` |
| `/policies` | `GET /policies` | `VIEWER+` |
| | `POST /policies` (201) · `PATCH /policies/:id` · `GET /policies/:id/versions` | `ADMIN, FINANCE` |
| `/cases` | `GET /cases` (filters + cursor) · `GET /cases/:id` · `GET /cases/:id/timeline?types&from&to&limit&cursor&order` (multi-entity merge) · `GET /cases/:id/outcome` (404 `NO_OUTCOME`) | `VIEWER+` |
| | `POST /cases/:id/pause` · `/resume` (202) | `OPERATIONS, FINANCE, ADMIN` |
| | `POST /cases/:id/escalate {notes?}` (202) | `SUPPORT, OPERATIONS, FINANCE, ADMIN` |
| | `POST /cases/:id/stop {reason!}` (202) | `FINANCE, ADMIN` |
| `/payments` | `GET /payments/:id` (+ attempts timeline) | `VIEWER+` |
| | `GET /payments/:id/status` (live gateway, `refreshed` flag) | `OPERATIONS+`, 30/min |
| `/messages` | `GET /messages?case_id&customer_id&channel&status&limit&offset` (PII-masked) · `GET /messages/:id` (+ delivery_events) | `VIEWER+` |
| `/human-tasks` | `GET /human-tasks`, `GET /human-tasks/:id` | `VIEWER+` |
| | `POST /human-tasks` (201) | `OPERATIONS+` |
| | `POST /human-tasks/:id/approve`, `/:id/reject {notes!}` | `OPERATIONS+` **session-only** (API key → 403) |
| | `POST /human-tasks/:id/assign`, `/:id/cancel` | `FINANCE, ADMIN` |
| `/promises-to-pay` | `GET /promises-to-pay?status&customer_id`, `GET /promises-to-pay/:id` | `VIEWER+` |
| | `POST /promises-to-pay/:id/mark-honored` | `FINANCE, ADMIN` |
| `/audit` | `GET /audit?case_id&actor_type&event&from&to&limit&cursor` | **ADMIN only** |
| `/outcomes` | `GET /outcomes?from&to&surface&method&customer_id&limit&cursor` (+ `aggregates{recovered/cost/net_minor,count}`) | `VIEWER+` |
| | `GET /outcomes/cases/:id` | `VIEWER+` |
| `/analytics` | `GET /analytics/summary`, `/recovery?bucket=day\|week`, `/interventions`, `/funnel`, `/risk-mix`, `/ai?from&to` (max **370d**) | Global `requireAuth + VIEWER+`; non-`FINANCE/ADMIN` gets `x-cost-data-redacted:true` on cost endpoints; Redis 30s single-flight cache |
| `/demo` | `POST /demo/payment-fail`, `/payment-succeed`, `/checkout-abandon`, `/invoice-overdue` · `PATCH/GET /demo/injections` | Mock-mode + session `OPERATIONS/ADMIN/FINANCE` OR key `demo\|*` |
| | `POST /demo/mock/payments/:key/next-outcome` | **Open (no auth)** — drives `MockPaymentProvider` |

Non-HTTP consumers/jobs (no REST surface): `risk/consumer`, `cases/consumer` (orchestrator), `PaymentSuccessSignalBridge`, `CheckoutCompletedSignalBridge`, `CustomerResponseSignalBridge`, `SlaSweeper`, `AttributionSweeper`, `CostCompletenessJob`, `retention.job`.

---

## 11. Core Domain Rules (Read Before Coding)

Binding rules: `docs/CONVENTIONS.md`. Decisions settled in `docs/adr/` — do not re-litigate.

### 11.1 Module layout & naming

- Backend routes: `*.controller.ts` → routes + JSON Schemas (no logic); `*.service.ts` → logic + transaction boundaries; `*.types.ts` → types. Cross-cutting in `src/plugins/`. **No raw SQL outside `packages/db/src/repositories`.**
- `packages/domain` never imports apps/db/frameworks. `packages/config` alone reads `process.env`. Provider credentials reachable **only** from `packages/integrations`. Worker splits `workflows/` (deterministic, no network) vs `activities/` (side effects).
- Files `kebab-case` · vars `camelCase` · types `PascalCase` · constants `SCREAMING_SNAKE` · DB `snake_case` · events `<domain>.<event>` (`payment.failed`) · catalog actions `SCREAMING_SNAKE` (`RETRY_PAYMENT`) · case statuses `SCREAMING_SNAKE` · error codes `SCREAMING_SNAKE` · packages `@repo/*`.

### 11.2 Money (ADR-009) · Time (ADR-011) · Identifiers (ADR-010)

- **Money:** integer minor units (paise/cents) in `bigint` + ISO-4217 `currency CHAR(3)` beside every amount. **Never floats** — DB, TS, or JSON. Branded integer types in `@repo/domain`; display formatting (₹ Lakh/Crore grouping) only at the presentation edge.
- **Time:** store UTC `timestamptz`; expose ISO-8601 UTC. Business-day math uses tenant timezone only inside date-math utilities; results stored back as UTC. Workflow timers are relative durations anchored to decision time unless policy demands wall-clock.
- **IDs:** business PKs UUIDv4 (`gen_random_uuid()`); append-only logs add `bigserial` ordering; human case number `RC-{per-tenant-seq}` is display/search only, never a join/FK.

### 11.3 State machines (`packages/domain`, guarded writes only)

```text
RecoveryCase: DETECTED → QUALIFIED → DECISION_PENDING → POLICY_REVIEW
              → IN_PROGRESS ⇄ WAITING → RECOVERED | STOPPED | ESCALATED | FAILED
              terminals = RECOVERED, STOPPED, FAILED
RevenueRisk:  OPEN → OPEN | ASSESSED | EXPIRED   (terminals ASSESSED, EXPIRED)
PromiseToPay: MADE → HONORED | BROKEN | EXPIRED  (all terminal)
```

Every business-state DB write runs in an explicit service-owned transaction and uses **guarded conditional updates** (`UPDATE … WHERE status = <expected>`); unguarded writes fail review. Invariants additionally enforced by PG constraints (non-negative money, unique idempotency keys, enum statuses).

**Action catalog (closed, `s-03`):** unknown action types rejected at runtime (`tryValidateCatalogAction`) and schema level; per-surface `AI_DECIDABLE_ACTIONS` subsets; incentive caps vs `MAX_AUTO_DISCOUNT_MINOR`. **Policy limits** centralized in `packages/domain`.

### 11.4 Errors, logging, timeouts

- Canonical envelope (central Fastify handler maps domain errors → status; controllers never hand-build bodies):

```json
{ "error": { "code": "TENANT_CONTEXT_MISSING", "message": "human readable", "details": {} } }
```

Unknown → `500 INTERNAL_ERROR` (logged, never leaked). Validation → `VALIDATION_FAILED` + field details.

- **Logging:** structured JSON via Pino (`@repo/observability`); mandatory `correlation_id`, `tenant_id`, `case_id` when present. **Deny-by-default PII/secrets redaction** (`sk_*`, `whsec_*`, keys, tokens, full card/customer PII). Levels: `error` (needs action) / `warn` / `info` (state transitions) / `debug` (off in prod).
- **Timeouts & retries:** every external call (LLM 20s, providers, Redis, DB, Temporal) declares explicit timeout + bounded jittered-exponential retries. Financial actions derive idempotency keys as `tenant_id + recovery_case_id + action_type + attempt_number`.

### 11.5 AI boundaries + observability contract

- LLM may **only**: diagnose cause, rank interventions from the closed catalog, draft template-parameter content within allowlists, set stop conditions. It may **NEVER** move money, trigger retries, send messages, exceed discount caps, contact opted-out customers, or choose off-catalog actions. Every output passes **JSON-Schema → semantic → policy** validation. No tool-calling (ADR-008).
- Correlation: W3C `traceparent` + `x-correlation-id` (generated for webhooks). Five trace keys end-to-end: `event_id, case_id, workflow_id, decision_id, action_id` (span attrs `recovery.*`, `tenant.id`, `llm.model`, `provider.*`). Metrics baseline (HTTP/workflow/LLM/provider/policy/recovery) at `GET /metrics`.

---

## 12. Recovery Workflows (A/B/C) + Orchestration + Human Approvals

**Orchestration pipeline (`s-17`, `@repo/orchestration`):** consumer group `orchestrator` on `revenue-events.v1`: `risk.calculated → tryCreateCase → case.opened`, then resumable stages `QUALIFIED → DECISION_PENDING → POLICY_REVIEW → IN_PROGRESS / STOPPED / ESCALATED / FAILED`. Control APIs `/pause /resume /escalate /stop` use guarded transitions + timeline events + RBAC matrix; read APIs support filters, cursor pagination, 404 tenant isolation.

**Temporal foundation (`s-20`, `services/worker`, `@repo/worker`):** worker on queue `recovery-main`, namespace `revenue-recovery` (max 50 concurrent), 22 activities (snapshot, policy recheck, payments, messages, human tasks, timeline, metrics, guarded transitions, escalation), named retry policies (`STANDARD`, `PROVIDER_POLL`, `HUMAN_WAIT`, `NON_RETRYABLE`), error taxonomy (`VALIDATION_FAILED`, `POLICY_REJECTED`, `TERMINAL_DECLINE`, `CUSTOMER_OPTED_OUT`, `ENTITY_NOT_FOUND`), `WORKFLOW_ID = recover:${caseId}`, singleton client + ESLint determinism guard (`packages/eslint-config/worker.js` bans DB/fetch/fs/net in `workflows/**`).

| Workflow | File | Lifecycle | Key guards |
|---|---|---|---|
| **A: Failed Payment** (`s-22`) | `failed-payment.ts` | 3-round bounded retry loop → UNKNOWN-status polling → single bounded AI replan → human approval hook → `MAX_RETRIES` terminal stop; `PaymentSuccessSignalBridge` wakes on `external-payment-succeeded` | Anti-double-charge idempotency `{tenant}:{case}:RETRY_PAYMENT:{attempt}`; stop-condition checks; skippable wait with early wakeup. 12-scenario matrix. |
| **B: Checkout Abandonment** (`s-23`) | `checkout-abandonment.ts` | 30m inactivity watch → confirm abandonment → deferred case creation → Touch 1 reminder (**strict zero-discount invariant**) → 4h wait → purchase check → Touch 2 incentive (**≤ ₹500 cap**, policy-gated) → 24h wait → final check → Stop/Recovered | Atomic `completeRaceGuard` pre-touch; `CheckoutCompletedSignalBridge`. 8-scenario matrix. |
| **C: Overdue Invoice + PTP** (`s-24`) | `invoice-overdue.ts` + child `promise-to-pay.ts` | 3-touch ladder (Day-0 polite → +3d follow-up → +7d final + payment link); Scenario C `POL-HIGHVALUE` approval for >₹100k discounts; dispute hard stop; contact caps; child PTP `MADE→HONORED\|BROKEN\|EXPIRED` | `CustomerResponseSignalBridge`; `DailyReconciler` cron for orphaned invoices/expired PTPs; `GET /promises-to-pay`, `POST …/mark-honored`. 9-scenario matrix. |

**Human escalation (`s-21`):** `human_tasks` lifecycle (`PENDING → ASSIGNED → APPROVED/CANCELLED`), session-only decisions (API key → 403), guarded transitions, approve side-effects (case `ESCALATED→IN_PROGRESS`, actions `APPROVAL_REQUIRED→APPROVED` + Temporal `human-decision` signal) / reject (mandatory notes, `CANCELLED/HUMAN_REJECTED`), `SlaSweeper` emitting `human-task.sla-breached`, `awaitHumanApproval` with 60s crash-repair DB fallback, 1h burst dedup on `escalateWorkflowFailure`.

---

## 13. AI Decision Service + Governance + Eval Harness

**Core path (`s-14`, `apps/backend/src/modules/ai`):** versioned prompts `payment_failure@1`, `checkout_abandonment@1`, `invoice_overdue@1` (sha256 checksums, `prompts/registry.ts`); OpenAI-compatible client (20s timeout, N=2 exponential-backoff+jitter retries, circuit breaker 5 failures/60s cooldown, `SIMULATE_LLM_FAILURE` injection); structured parser with **N=1 repair retry** + deterministic rule-based fallback; paise token-cost tracking; guarded case validation + 24h Idempotency-Key; `POST /ai/decide`, `GET /ai/decisions/:id` (tenant-isolated, RBAC).

**Governance (`s-15`):** universal token parsing (OpenAI/Anthropic/Gemini), authoritative minor-unit pricing table with **fail-closed** unknown-model guard, confidence hook (`requiresApproval`), transactional `decision + recovery_cost_entries(category='LLM')` writes, `GET /ai/decisions` with input-snapshot masking (full snapshot ADMIN-only).

**Eval harness (`services/eval`, `@repo/eval`):** `run.ts` CLI (`--dataset/--prompt-version/--out/--mock/--live/--tamper`), `runner.ts` replaying `datasets/golden-v1.json` (30 cases × 3 surfaces with `must_not/should_any_of/cause_one_of/min_confidence`), drift + latency analysis, **CI gate: schema-validity ≥ 95% AND zero `must_not` violations**, prompt-change checklist in `docs/PROMPT_EVALUATION.md` (+ 13 adversarial tests in backend).

---

## 14. Dashboard (`apps/frontend`)

Next.js 16 App Router financial control plane (Tailwind 4, Recharts, Lucide, GSAP) — **observation only**, never computes business state.

| Route | Page | Contents |
|---|---|---|
| `/` | `RootPage` | Redirects to `/dashboard` |
| `/login` | `LoginPage` | `rr_session` form, `?from=` preservation, demo persona presets |
| `/dashboard` | `DashboardPage` | Overview cards, 5-stage funnel, risk-mix, timeseries, AI perf |
| `/cases` | `CasesPage` | Filterable case list |
| `/cases/[id]` | `CaseDetailPage` | Risk factors, DecisionCard, PolicyVerdict, ActionsLedger, OutcomeCard, 30s auto-refresh timeline, `?demo=1` screen-share scaling, pause/resume/escalate/stop modals |
| `/risk` | `RiskPage` | Bands + factors |
| `/recovery` | `RecoveryPage` | Recovered/ROI views |
| `/policies` | `PoliciesPage` | Rules + versions (create/edit modals) |
| `/tasks` | `TasksPage` | Human approval inbox + badge count |
| `/audit` | `AuditPage` | Admin-only timeline |
| `/settings` | `SettingsPage` | Users + API keys admin |

Auth: `middleware.ts` guards all dashboard routes via `rr_session` cookie (HttpOnly, backend-set); client `apiClient` (`lib/api.ts`, `credentials:include`) redirects 401 → `/login?from=…`. Client RBAC (`lib/rbac.ts`) mirrors the server: `VIEWER: read` · `SUPPORT: +escalate` · `OPERATIONS: +pause/resume/approve/replay/demo` · `FINANCE: +stop/policies` · `ADMIN: +users/keys` (UX gating only — server authoritative). Money formatted in minor units with ₹ Lakh/Crore grouping (`lib/money.ts`).

---

## 15. Demo Mode, Simulation & Seed Data

`MOCK_PROVIDERS=true` runs without live payment/messaging/LLM providers; when `false`, all provider credentials become required at startup and `/demo/*` returns `410 MOCK_DISABLED`.

- **Simulation endpoints:** `POST /demo/payment-fail`, `/payment-succeed`, `/checkout-abandon`, `/invoice-overdue` — drive full production pipelines via signed HMAC loopbacks + Temporal signals.
- **Failure injection:** `PATCH/GET /demo/injections` — Redis-backed switches (`SIMULATE_PAYMENT_TIMEOUT/MESSAGE_FAILURE/LLM_FAILURE/DUPLICATE_WEBHOOK`) with 15m sliding TTL + dynamic LLM override (no restart).
- **Seeds (`packages/db/src/seeds/`):** deterministic Mulberry32 factories (SHA-256 content-hash verified) generating spec §24 volumes — 1,000 customers, 2,500 payments, 400 checkouts, 180 invoices, 100 cases, 45 outcomes, 90 cost entries — plus pristine pre-trigger **Scenarios A (CUS-001 payment fail) / B (CUS-002 checkout abandon) / C (CUS-003 invoice overdue)** and tenant-scoped safe `reset`.
- **9-scene live script** (`docs/demo-script.md`, 3–5 min): Baseline (₹12.8L risk) → `payment-fail` (CUS-001 ₹12,999) → Case HIGH 86/100 → AI `insufficient_funds` (WhatsApp + 24h + retry) → Policy ALLOWED → Temporal `recover:<caseId>` WAIT→MESSAGE→RETRY → `payment-succeed` → ROI (risk −₹12,999, RECOVERED) → immutable audit trail.

---

## 16. Observability

(`@repo/observability`, ADR-014.) Idempotent OTel tracing provider with Bun-compatible choke-point spans (`withSpan`), standard attrs (`recovery.event_id/case_id/workflow_id/decision_id/action_id`, `tenant.id`, `llm.model`, `provider.name/operation`), Prometheus registry (`prom-client`) with the spec §20 metric families (`http_*, db_*, events_*, risk_*, policy_*, llm_*, provider_*, workflow_*, auth_*, webhook_*, bus_*, context_*, pipeline_*, case_funnel_*, human_tasks_*, approval_*, audit_*, outcome_*`), Fastify request tracing/metrics hooks, Pino structured logger with secret redaction + trace mixing, `GET /metrics` exposition, compose `otel-collector` (`:4317 gRPC, :4318 HTTP, :8888 metrics`), Grafana provisioning stubs (`infra/grafana`).

---

## 17. Security, Auth & Tenant Isolation

Design reference: ADR-012.

- **Sessions:** `rr_session` cookie (httpOnly, SameSite=Lax, Secure in prod), `user_sessions` table + Redis 60s hot path, 12h sliding renewal, argon2id passwords, login rate-limit 5/min per IP+email with lockout backoff. **API keys:** `Authorization: Bearer rrk_<tenant>_<random>`, SHA-256 lookup, async `last_used_at` touch, revocation.
- **Plugin pipeline:** `request.auth = {kind: session|api_key|webhook, userId?, tenantId, role, scopes?}` → `requireAuth` (401) → `requireRole(...)` (403) → **`getTenantScope(request)` mandatory guard** (missing → `400 TENANT_CONTEXT_MISSING`; tenantId never taken from unverified params — cross-tenant access structurally impossible). Scopes: `events:write`, `ai:decide`, `policy:evaluate|worker`, `demo`, `*`.
- **Role matrix:** most reads `VIEWER+`; mutations `OPERATIONS+`; money/policy/admin `FINANCE/ADMIN`; `/audit` ADMIN-only; human approve/reject additionally **session-only**. See §10 per-endpoint table (server authoritative; frontend `lib/rbac.ts` mirrors for UX).
- **Webhooks:** signature verification precedes all processing (Stripe ±5m window, Razorpay/WhatsApp constant-time HMAC, email token); secrets rotatable zero-downtime (`docs/runbooks/webhook-secrets-rotation.md`); provider SDKs/creds confined to `packages/integrations`; `.env` gitignored; logs deny-by-default on secrets/PII.

---

## 18. Testing

Primary runner **Vitest** (root `vitest.config.ts` workspace discovering `packages/*/src/**/*.test.ts`, `apps/*/src/**/*.test.ts`, `services/*/src/**/*.test.ts`; 30s timeouts). `bun test` allowed only for pure domain units (ADR-013).

- **Coverage:** unit (domain/risk/policy/schema/transitions) · integration (webhook→DB→bus→AI→policy→workflow→adapter→outcome) · workflow (Temporal time-skipping test server) · E2E (composed stack, `s-32`). Test suites include the domain transition/envelope/catalog matrix, webhook and context suites, governance and adversarial suites, policy suites, orchestration and worker suites, audit and analytics suites, frontend unit/component tests, workflow scenario matrices, and demo-simulation tests. Shared fixtures/factories live in `packages/testing` + `packages/db/src/seeds/factories.ts` — never hand-build financial rows when a factory exists.
- **Layers** (spec 01 §23): unit · integration · workflow · E2E as above.
- **Failure injection** (spec 03 §9): adapters + `/demo/injections` honor `SIMULATE_*` so resilience claims are executable.

```bash
bun run test                 # full vitest workspace
bunx vitest run <file>       # single file, e.g. demo-simulation.test.ts
bun --filter frontend test   # frontend suite (happy-dom + testing-library)
```

---

## 19. Database

(`s-04`–`s-06`, `@repo/db`, ADR-003/004.) Drizzle ORM on pooled `postgres.js`; **PostgreSQL is the source of truth** for outcomes + audit.

- **33 tables + 6 analytics views.** Financial core (`s-04`, migration `0000`): `tenants, users, api_keys (+user_sessions s-09), customers, payments, payment_attempts, subscriptions, checkouts, checkout_events, invoices, invoice_events` (citext, pgEnums mirroring `@repo/domain`, check/unique constraints, spec indexes). Recovery domain (`s-05`, migration `0001`): `events, revenue_risks, recovery_cases, ai_decisions, recovery_actions, workflows, workflow_events, messages, message_delivery_events, customer_responses, promises_to_pay, human_tasks (+0006 overdue_at/escalation_count), policy_rules, policy_versions, policy_evaluations, audit_logs, case_events (+audit_archive/retention 0007/0008), recovery_outcomes (generated `net_recovered` column), recovery_cost_entries, idempotency_keys`. Analytics (`s-27`, migration `0009`): `v_recovery_summary, v_recovery_timeseries, v_intervention_performance, v_funnel, v_risk_mix, v_ai_performance`.
- **5 anti-duplication anchors** proven (events `(source, external_event_id)`; payment-attempt + action/message idempotency keys; outcome uniqueness; case-event dedupe). **Migrations:** 11 forward-only SQL files in `packages/db/drizzle/` (`0000`–`0010` + journal), advisory-locked runner (`724193`) with transient retries, `db:migrate:check` CI gate (`0010`, s-35: transaction-local audit-reset hatch for the slug-guarded demo reset; triggers default-deny elsewhere).
- **Repositories:** 28 aggregate repos with tenant-first signatures, `withTransaction` wrapper, guarded state transitions, advisory-locked per-tenant case numbering, compile+runtime append-only enforcement; boundary table in `packages/db/README.md`.
- **Outcomes (`s-26`):** `OutcomeRecordService` single choke point (idempotent no-op, competing-payment warnings, guarded `→RECOVERED`, `SUM(recovery_cost_entries)` rollup); `AttributionSweeper` (hourly, 4 strict conditions); `CostCompletenessJob` (daily gap audit, messaging pricing 50p/5p/25p); `docs/attribution.md` defines attribution.

```bash
bun run db:migrate            # apply all migrations
bun run db:migrate:check      # CI: fail if any pending
bun run db:seed               # seed demo volumes (+ --reset for deterministic reset)
```

ERD: `docs/ARCHITECTURE.md` §6 (Mermaid, 20+ relations). Field contract: `docs/audit-field-contract.md`.

---

## 20. Roadmap & Implementation Order

Work is executed as an ordered roadmap: `specs/steps/s-XX.md` (full requirements + Definition of Done) → implement **only** that step → verify → update `specs/steps/progress.md` + `docs/TRACEABILITY.md` + `docs/explanation/s-XX-explanation.md`. Live execution status lives in [`specs/steps/progress.md`](./specs/steps/progress.md) — this README intentionally does not duplicate it.

| Phase | Steps | Scope |
|---|---|---|
| Foundation (architecture, infra, domain) | `s-01`–`s-03` | ADRs, conventions, compose stack + typed config, shared domain package |
| Data layer (schemas, repositories) | `s-04`–`s-06` | Financial core schema, recovery schema, migrations + repositories |
| Platform (API skeleton, observability, auth) | `s-07`–`s-09` | Fastify skeleton, tracing/metrics/logging, sessions/API keys/RBAC |
| Ingestion (gateway, bus, risk, context) | `s-10`–`s-13` | Webhooks, event bus + replay, risk engine, context service |
| Intelligence (AI decision, governance, policy) | `s-14`–`s-16` | Decision path, eval harness, policy engine |
| Execution (orchestration, adapters, Temporal, approvals) | `s-17`–`s-21` | Case pipeline, payment/messaging adapters, worker foundation, human tasks |
| Workflows (payment, checkout, invoice) | `s-22`–`s-24` | Failed-payment, checkout-abandonment, invoice-overdue + promise-to-pay |
| Product (audit, outcomes, analytics, dashboard, demo) | `s-25`–`s-29` | Audit timeline, outcomes/attribution, analytics, dashboard UI, demo + seeds |
| Verification & ship (security, chaos, e2e, deploy, ops, release) | `s-30`–`s-35` | Hardening, resilience testing, acceptance tests, CI/CD, monitoring, release |

Milestone gates (G1 data layer → G2 events flow → G3 headless loop → G4 durable execution → G5 demoable product → G6 release gate → G7 shipped) and the full dependency graph are defined in `specs/steps/README.md` and tracked in `specs/steps/progress.md`.

---

## 21. Documentation Index

| Doc | Purpose |
|---|---|
| `docs/RELEASE-v0.1.0.md` | **v0.1.0 sign-off**: §29 gate 18/18, §12 ticks, known limitations L1–L6, deferral register D1–D7 |
| `CHANGELOG.md` | v0.1.0 generated from the completion log (per-step) |
| `docs/ARCHITECTURE.md` | System map: naming, diagram, responsibility table, target layout, gap review, ERD |
| `docs/CONVENTIONS.md` | **Binding** engineering rules (§1–§15: layout, money/time/ids, errors, logging, retries, AI limits, testing, git) |
| `docs/TRACEABILITY.md` | Requirement → step matrix (MVP, DoD-18, acceptance blocks, failure switches, metrics, §8 release re-audit) |
| `docs/adr/README.md` + `docs/adr/ADR-001…016` | Settled decisions: runtime, Fastify, Postgres+Drizzle, migrations, Temporal, Redpanda+inproc, Redis, LLM structured outputs, money, ids, time, auth, Vitest, observability, RLS-deferral, pushgateway (+ `design-frontend.md` advisory note) |
| `docs/explanation/s-XX-explanation.md` | Per-step explainers for completed steps (s-35 closes the series) |
| `docs/demo-script.md` | 9-scene live demo walkthrough, measured numbers, two tracks, friction log (spec 01 §27) |
| `docs/attribution.md` | Outcome attribution definition (`s-26`) |
| `docs/audit-field-contract.md` | Canonical audit/timeline field contract (`s-25`) |
| `docs/PROMPT_EVALUATION.md` | Prompt-change checklist + eval gate (`s-15`) |
| `docs/SECURITY-CHECKLIST.md` | 10/10 security acceptance rows, evidence-linked (`s-30`) |
| `docs/RESILIENCE.md` | 14-scenario failure-handling evidence table (`s-31`) |
| `docs/PERFORMANCE.md` | Measured values vs spec 03 §10 targets (`s-34`) |
| `docs/SLO.md` + `docs/LOGGING.md` | SLOs/error-budget policy + case-tracing log queries (`s-34`) |
| `docs/runbooks/` (14 + firing-drill) | Per-alert runbooks, each linked from its alert (`s-34`) |
| `docs/deploy/` (5 runbooks) | Environments, migrations, webhooks, crons, rollback (`s-33`) |
| `docs/runbooks/webhook-secrets-rotation.md` | Zero-downtime Stripe/Razorpay secret rotation |
| `specs/00…03` | Source of truth: vision, 0-to-100 plan, architecture/domain, MVP spec (**do not edit**) |
| `specs/steps/s-01…s-35 + progress.md` | Ordered roadmap; `progress.md` is the resume point |
| `AGENTS.md` | How to execute a step (binding on every change) |

Check doc links after editing docs: `bun run check-docs`.

---

## 22. Contributing & Agent Workflow

Binding file: [`AGENTS.md`](./AGENTS.md). Summary (read the file itself before coding):

1. Read the step file `specs/steps/s-XX.md` **fully** first — its Definition of Done is the acceptance contract.
2. Implement **only** what that step requires. No later-step features, no drive-by refactors. All state machines live in `packages/domain`; DB writes use guarded conditional updates (`CONVENTIONS` §9). Secrets never enter code/logs/git (§12).
3. Verify with the step's checks + §23 commands.
4. Finish by updating `specs/steps/progress.md` (status row, current position, completion log) + `docs/TRACEABILITY.md` + mandatory `docs/explanation/s-XX-explanation.md` (model on `s-2`/`s-3` explainers).
5. Which docs when: `CONVENTIONS.md` every session; `ARCHITECTURE.md` before creating/wiring files (§4 layout, §5 gaps); ADRs on trigger (money→009, tables/ids→010, time→011, routes→002, DB→003/004, events→006, Redis→007, LLM→008, auth→012, tests→013); `specs/*.md` only the cited section.
6. Git: branches `feat/<step-id>-<slug>` (fixes `fix/<slug>`); commits `s-07: …` with step prefix; one step per PR linking its DoD. Never modify `specs/` except `specs/steps/progress.md`. No behavior change outside step scope.

---

## 23. Verification Commands

From repo root (POSIX-style paths; Bun ≥ 1.4):

```bash
bun run check-types   # turbo check-types — MUST pass before finishing any step
bun run lint          # turbo lint (backend, worker configs)
bun run test          # vitest workspace (add tests per step's Tests section)
bun run check-docs    # after editing any docs/*.md links
bun run db:migrate:check  # CI: no pending migrations
```

---

## 24. Troubleshooting

| Symptom | Likely cause → fix |
|---|---|
| `infra:up` unhealthy / port conflict | Another PG/Redis/Temporal running → `docker ps`, stop conflicts or `bun run infra:down` then `up`. Required ports: §6. |
| `db:migrate` connection refused | Postgres not ready → wait for `pg_isready` healthcheck; verify `DATABASE_URL`/`DIRECT_URL` point at `:5432/revenue_recovery`. |
| Backend 401 on every call | Missing/expired `rr_session` or malformed `rrk_*` → log in via `/login` (cookies need `credentials:include` / same-site context) or re-issue key via `/admin/api-keys`. |
| 403 on approve/reject | Human-task decisions are **session-only** → use cookie session, not API key. |
| 400 `TENANT_CONTEXT_MISSING` | No tenant scope (bad session/key or missing tenant) → re-login; never pass tenant via body params. |
| 406 on webhooks | Missing `Content-Type: application/json` → set header; raw body required for HMAC. |
| 410 `MOCK_DISABLED` on `/demo/*` | `MOCK_PROVIDERS=false` in prod → demo routes intentionally omitted. |
| 429 `RATE_LIMITED` | Hit global 1000/min or per-route override (webhooks 600/min, `/events` 60/min, payment status 30/min) → back off; check Redis. |
| Temporal workflows not starting | Worker not running / wrong namespace/queue → ensure worker up with `TEMPORAL_NAMESPACE=revenue-recovery`, `TEMPORAL_TASK_QUEUE=recovery-main`; check Temporal UI `:8080`. |
| Redpanda consumer silent | `EVENT_BUS_DRIVER` mismatch → `inprocess` for local single-process, `redpanda` needs `REDPANDA_BROKERS=localhost:9092`; inspect console `:8081`. |
| Next build inlines wrong API URL | `NEXT_PUBLIC_API_URL` baked at build → set in `apps/frontend/.env.local` **before** `next build` / Docker build-arg. |
| Windows path issues | Run from repo root; use `workdir`-style absolute paths; scripts expect POSIX separators. |

---

## 25. Explicitly Out of Scope (Post-MVP)

From spec 01 §30 + spec 03 §1 Later/No rows (`docs/TRACEABILITY.md` §7). **Not assigned steps**; revisit only after v0.1.0 gate G7: multi-agent architecture · fine-tuned LLM · vector DB before retrieval is needed · full ML pipeline / ML risk scoring · voice agent · Kafka cluster complexity (beyond optional Redpanda compose service) · 20 third-party providers · complex pricing engine · autonomous discount negotiation / fully autonomous collections · advanced experimentation/playbooks · CRM/ERP/telephony adapters (interfaces reserved in `packages/integrations`).

---

*Sources: `specs/00…03`, `specs/steps/` (`README`, `progress`, `s-01…s-35`), `docs/ARCHITECTURE.md`, `docs/CONVENTIONS.md`, `docs/TRACEABILITY.md`, `docs/adr/ADR-001…014`, `.env.example`, `infra/docker/docker-compose.yml`, `apps/backend` (app/server/modules/plugins/routes), `apps/frontend` (routes/lib/middleware), `packages/*`, `services/worker` + `services/eval`, `docs/demo-script.md`. Previous root README was the Turborepo starter template and has been fully replaced.*
