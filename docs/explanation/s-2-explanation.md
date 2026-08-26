# s-02 — Local Infrastructure & Configuration Platform: Implementation Explanation

This document explains, in complete depth, everything that was done to implement `specs/steps/s-02.md`. It is written so that a developer (or future agent) who was not present during implementation can understand every file, every decision, every deviation, and every problem that had to be debugged along the way.

---

## Table of contents

1. [What the step required](#1-what-the-step-required)
2. [Docker Compose stack (`infra/docker/docker-compose.yml`)](#2-docker-compose-stack)
3. [Temporal dynamic config (`infra/temporal/dynamicconfig.yaml`)](#3-temporal-dynamic-config)
4. [The config package (`packages/config`)](#4-the-config-package-packagesconfig)
5. [Environment hygiene (`.env.example`, `.gitignore`)](#5-environment-hygiene)
6. [Root scripts and workspace wiring](#6-root-scripts-and-workspace-wiring)
7. [Backend stub migration to `@repo/config`](#7-backend-stub-migration-to-repoconfig)
8. [Migration scaffold for `db:migrate`](#8-migration-scaffold-for-dbmigrate)
9. [Problems discovered during verification and their fixes](#9-problems-discovered-during-verification-and-their-fixes)
10. [Verification evidence (Definition of Done)](#10-verification-evidence-definition-of-done)
11. [Deviations and judgment calls](#11-deviations-and-judgment-calls)

---

## 1. What the step required

Step s-02 has one objective: stand up the **complete local infrastructure** via Docker Compose (PostgreSQL, Redis, Temporal + Temporal UI, Redpanda + console, and Next.js frontend) with working health checks, and build the **typed configuration package** (`@repo/config`) that every app/service uses to load and validate environment variables instead of reading raw strings off `process.env`.

The Definition of Done checklist (from the step file):

- `docker compose -f infra/docker/docker-compose.yml up -d` brings up all 7 services, all healthchecks green within 90s
- Temporal UI reachable at :8080 and namespace `revenue-recovery` visible
- Redpanda console reachable at :8081
- Next.js frontend reachable at :3000
- `bun run db:migrate` succeeds against composed Postgres (empty migration set)
- `@repo/config` exports typed configs; apps import it instead of reading `process.env` directly
- `.env.example` updated; no real secrets anywhere in git
- Unit tests for config validation written and passing

Everything below maps to those items.

---

## 2. Docker Compose stack

**File:** `infra/docker/docker-compose.yml`

### 2.1 Service inventory and ports

| Service | Image / Build | Host port | Purpose |
|---|---|---|---|
| `postgres` | `postgres:16-alpine` | 5432 | Source of truth DBs: `revenue_recovery` (app) plus Temporal's persistence |
| `redis` | `redis:7-alpine` | 6379 | Cache / locks / rate-limit / idempotency fast path (ADR-007), used from s-10 onward |
| `temporal` | `temporalio/auto-setup:1.28.0` | 7233 | Workflow engine server; auto-provisions its schemas on boot |
| `temporal-ui` | `temporalio/ui:2.32.0` | 8080 | Web UI for workflows |
| `redpanda` | `redpandadata/redpanda:v24.3.1` | 9092 | Kafka-compatible event bus (ADR-006), topic work starts at s-11 |
| `redpanda-console` | `redpandadata/console:v2.8.1` | 8081 | Web UI for topics/messages — the step file explicitly sanctions this as an "architectural addition" |
| `frontend` | `apps/frontend/Dockerfile` (standalone) | 3000 | Next.js frontend dashboard containerized with standalone server output |

All images are pinned by tag and the frontend is built from a multi-stage Dockerfile so a fresh clone cannot silently get a broken or behaviorally different version.

### 2.2 Health checks

Every service declares a healthcheck so dependents can gate on real readiness rather than container start:

- **postgres**: `pg_isready -U postgres -d revenue_recovery` — verifies both auth and database existence.
- **redis**: `redis-cli ping | grep -q PONG`.
- **temporal**: `nc -z $(hostname -i) 7233` — see section 9.1 for why the plain-loopback variant fails.
- **temporal-ui / redpanda-console**: `wget --spider http://127.0.0.1:<port>/` — HTTP liveness against their own serving port.
- **redpanda**: `rpk cluster health ... | grep healthy` — verifies broker membership reports healthy, not just that the process is up.
- **frontend**: `wget --spider http://127.0.0.1:3000/` — HTTP liveness against Next.js serving port.

Intervals are aggressive (5s) with generous retries/start periods so a cold `docker compose up -d --wait` converges without manual ordering — this is exactly what the step's Reliability section demands: *health checks gate dependent containers so a cold start converges*.

### 2.3 Dependency graph

```
postgres ──healthy──► temporal ──healthy──► temporal-ui
redpanda ──healthy──► redpanda-console
redis                 (independent)
frontend              (independent dashboard)
```

`depends_on` uses `condition: service_healthy` (not merely `service_started`) throughout, which is what makes the single-command cold boot reliable.

### 2.4 Volumes and restart policy

Named volumes `postgres-data`, `redis-data`, `redpanda-data` persist state across container recreations. Temporal needs no volume of its own because its entire state lives inside the composed Postgres (see below). Every service runs with `restart: unless-stopped` for dev ergonomics — the stack survives Docker Desktop/host restarts, as documented in the step's Reliability section, while still being removable with `bun run infra:down`.

### 2.5 Temporal persistence model

The header comment documents this explicitly: we use the `temporalio/auto-setup` image pointed at the **composed postgres**, letting auto-setup create and own two dedicated databases:

- `temporal` — workflow/event persistence
- `temporal_visibility` — search-attribute/visibility store

Key env vars on the service: `DB=postgres12`, `POSTGRES_SEEDS=postgres`, `POSTGRES_USER/PWD=postgres`, `DBNAME=temporal`, `VISIBILITY_DBNAME=temporal_visibility`.

Application data stays fully separate in `revenue_recovery`. This separation is documented loudly in the compose comments per the step requirement ("Document this in compose comments").

### 2.6 Namespace auto-create

Two env vars make the application namespace exist from first boot with zero manual steps:

```yaml
ENABLE_NAMESPACE_CREATE: "true"
DEFAULT_NAMESPACE: revenue-recovery
```

Verified after boot with `tctl namespace describe` → `Name: revenue-recovery, State: Registered`.

### 2.7 Redpanda dual-listener pattern

Redpanda advertises addresses to clients, and a naive single-listener setup breaks either host clients or container clients. The compose uses the standard dev topology:

```text
--kafka-addr internal://0.0.0.0:29092,external://0.0.0.0:9092
--advertise-kafka-addr internal://redpanda:29092,external://localhost:9092
```

- Containers (e.g., console) connect to `redpanda:29092`.
- Host processes (backend, worker, tests) connect to advertised `localhost:9092`.

When s-11 lands, consumer code simply uses `REDPANDA_BROKERS=localhost:9092` and it works both from the host and (with the internal listener available) inside compose networks.

### 2.8 Security posture

Dev-only default credentials (`postgres/postgres`) are called out in the file header as forbidden outside local development; production must source values from a secret manager (CONVENTIONS §12). No secrets beyond those documented defaults appear anywhere in the file.

---

## 3. Temporal dynamic config

**File:** `infra/temporal/dynamicconfig.yaml`

Minimal, purposeful content:

```yaml
limit.maxIDLength: [{ value: 255, constraints: {} }]
system.forceSearchAttributesCacheRefreshOnRead: [{ value: true, constraints: {} }]
```

- `limit.maxIDLength=255`: our workflow IDs will be composite (tenant/case-scoped) IDs; 255 avoids surprises.
- Search-attribute cache refresh-on-read is a local-dev convenience — attribute changes become visible immediately without waiting for periodic propagation.

The mount path matters and is commented in the compose file: the file is mounted read-only at `/etc/temporal/config/dynamicconfig/docker.yaml`, which is the filename the server resolves in the docker profile.

Namespace creation deliberately does **not** live here — it is handled by the container env vars (section 2.6), and the YAML header says so explicitly to prevent future confusion.

---

## 4. The config package (`packages/config`)

This is the largest piece of new code. It establishes the rule from CONVENTIONS §1: **`packages/config` is the only place `process.env` is read; everything else consumes typed config.**

### 4.1 File layout

```text
packages/config/
├── package.json          # name @repo/config, zod dependency, check-types script
├── tsconfig.json         # extends @repo/typescript-config/base.json
└── src/
    ├── env.ts            # raw zod schemas per group + parse/validate entry point
    ├── api.ts            # apiConfig() → full ServerConfig
    ├── worker.ts         # workerConfig() → same surface today (delegates to apiConfig)
    ├── web.ts            # webConfig() → browser-safe subset only
    ├── index.ts          # re-exports everything
    └── config.test.ts    # 13 vitest unit tests
```

Matches the tree in the step file (plus `web.ts`, since the requirements demand a `webConfig()` preset).

### 4.2 Schema groups (`env.ts`)

Ten zod schema groups mirroring the step's "Config groups" list exactly:

| Group | Keys | Defaults / notes |
|---|---|---|
| `appSchema` | NODE_ENV, PORT, LOG_LEVEL | dev/info/8000 defaults |
| `databaseSchema` | DATABASE_URL (required), DIRECT_URL | DIRECT_URL optional; falls back to DATABASE_URL in the typed output |
| `redisSchema` | REDIS_URL | required |
| `temporalSchema` | TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE | namespace defaults `revenue-recovery` |
| `busSchema` | EVENT_BUS_DRIVER, REDPANDA_BROKERS | driver enum `redpanda|inprocess`, default `inprocess` |
| `aiSchema` | LLM_API_KEY, AI_MODEL, LLM_BASE_URL, LLM_TIMEOUT_MS, LLM_MAX_RETRIES | gpt-4o / 20000ms / 2 retries defaults |
| `paymentsSchema` | STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET | all optional at schema level |
| `messagingSchema` | WHATSAPP_API_KEY, WHATSAPP_PHONE_NUMBER_ID, EMAIL_API_KEY, EMAIL_FROM | all optional at schema level |
| `demoSchema` | MOCK_PROVIDERS, SIMULATE_PAYMENT_TIMEOUT, SIMULATE_MESSAGE_FAILURE, SIMULATE_LLM_FAILURE, SIMULATE_DUPLICATE_WEBHOOK | mock resolved dynamically; SIMULATE_* default false |
| `otelSchema` | OTEL_EXPORTER_OTLP_ENDPOINT | optional URL; reserved now so s-08 needs no config change |

A separate `webPublicSchema` (NODE_ENV + NEXT_PUBLIC_API_URL) exists for `webConfig()`.

### 4.3 Cross-field rules via `superRefine`

Two business rules live in a refinement over the merged server schema:

1. **Provider-key gating (spec 03 §2)**: when effective mock mode is OFF, all nine provider credentials (LLM key, Stripe triple, Razorpay triple, WhatsApp pair, EMAIL_API_KEY) become mandatory. Effective mock mode = explicit `MOCK_PROVIDERS` if set, else `NODE_ENV !== "production"`. This makes the failure happen at boot with a precise message naming every missing variable, instead of a mysterious provider-auth error mid-demo.
2. **Bus driver consistency**: `EVENT_BUS_DRIVER=redpanda` requires `REDPANDA_BROKERS`; the `inprocess` default keeps early steps runnable before bus work begins.

### 4.4 Empty-string normalization

A subtle but important detail: env files often contain `LLM_API_KEY=` (empty value). Zod would treat that as "present but invalid length". `normalizeSource()` strips empty (and whitespace-only) entries **before parsing**, so empty means unset — optionality then behaves the way developers expect, and live-mode refinement correctly flags it. This is unit-tested ("treats empty-string variables as unset").

### 4.5 Fail-fast errors

`parseServerEnv()` uses `safeParse` and throws `ConfigValidationError` whose message lists each issue as `- PATH: message`. A missing `DATABASE_URL` therefore produces something like:

```text
Invalid environment configuration:
- DATABASE_URL: Required
- REDIS_URL: Required
...
```

Clear enough to fix without opening source code — directly satisfying the test requirement "missing DATABASE_URL throws with clear message".

### 4.6 Typed outputs and immutability

`api.ts` maps validated raw env into nested interfaces (`ServerConfig` containing `AppConfigValues`, `DatabaseConfig`, ..., `OtelConfig`):

- Money-like value transformations are avoided here (nothing to transform yet).
- Credentials that are absent become `null`, not `undefined` — forces callers to acknowledge nullability explicitly (CONVENTIONS-friendly).
- `DATABASE_URL` fallback for `DIRECT_URL` happens here, matching the existing migrate.ts semantics.
- Every group and the root object pass through `Object.freeze`, enforcing the step rule *"config is immutable after boot; no runtime re-reads"*.

### 4.7 Presets

- **`apiConfig(source?)`** — full server surface; accepts an injectable source object (defaults to `process.env`). Injectable sources keep tests hermetic and enable multi-env loading later.
- **`workerConfig(source?)`** — returns the same validated surface, delegating to `apiConfig()` with a docstring explaining why (worker activities will call integrations that need payments/messaging keys) and where to split if least-privilege slicing becomes necessary. Honest parity beats fake divergence.
- **`webConfig(source?)`** — browser-safe only: `{ env, publicApiUrl }`. Structurally prevents secrets from crossing into frontend code (CONVENTIONS §12).

### 4.8 Tests (`config.test.ts`, 13 cases)

Using a hermetic `baseEnv()` helper (no `process.env` mutation):

1. valid env parses, all defaults applied correctly
2. returned object is deeply frozen
3. missing `DATABASE_URL` throws `ConfigValidationError` mentioning it
4. invalid `EVENT_BUS_DRIVER` (`kafka`) rejected
5. `redpanda` driver without brokers rejected; with brokers passes with correct shape
6. `MOCK_PROVIDERS=true` allows all provider keys missing → they surface as `null`
7. mock mode defaults to true outside production
8. `MOCK_PROVIDERS=false` produces one error naming every required key
9. production defaults to live-provider requirements even without explicit flag; passing all keys succeeds
10. empty-string variables treated as unset
11–13. `workerConfig` parity and `webConfig` defaults/override behavior

An `expectConfigError` helper asserts both instance type and message substring — asserting the *contract*, not incidental wording.

---

## 5. Environment hygiene

- **`.env.example` extended** with: `LOG_LEVEL`, `TEMPORAL_NAMESPACE`, `EVENT_BUS_DRIVER` (+ explanatory comment about the `redpanda` ⇒ brokers requirement), `LLM_BASE_URL` / `LLM_TIMEOUT_MS` / `LLM_MAX_RETRIES`, a new "Demo Mode & Failure-Injection" section carrying `MOCK_PROVIDERS` and all four `SIMULATE_*` switches with commentary, and an "Observability" section reserving `OTEL_EXPORTER_OTLP_ENDPOINT` for s-08.
- Frontend note added: `NEXT_PUBLIC_*` vars belong in `.env.local` (gitignored) because Next.js inlines them at build time — per the step's ".env.local support note".
- **`.gitignore` hardened.** The old block enumerated five specific filenames, which would happily commit files like `.env.production`. Replaced with:

```gitignore
.env*
!.env.example
```

which covers every current and future dotfile-env variant at any depth while keeping the template tracked. Verified with `git check-ignore .env`.

---

## 6. Root scripts and workspace wiring

`package.json` gains:

```json
"infra:up":   "docker compose -f infra/docker/docker-compose.yml up -d --wait",
"infra:down": "docker compose -f infra/docker/docker-compose.yml down"
```

`--wait` is deliberate: `infra:up` does not return until every healthcheck is green, turning the DoD item into a self-verifying command. Turbo picks nothing special here (plain passthrough scripts), but bun exposes them repo-root wide per the step's "root-level convenience scripts".

Workspace changes: `packages/config/package.json` declares `zod ^3.25.76` and `"exports": { ".": "./src/index.ts" }` following the repo's source-export convention (no build step, consumers import TS directly); `apps/backend/package.json` adds `"@repo/config": "workspace:*"`; lockfile updated via `bun install`.

---

## 7. Backend stub migration to `@repo/config`

DoD: *"apps import it instead of reading `process.env` directly."*

Before:

```ts
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8000;
```

After (`apps/backend/src/index.ts`):

```ts
import { config as loadEnv } from "dotenv";
import path from "path";
import { apiConfig } from "@repo/config";

// Dev convenience: load the repo-root .env (silent no-op when absent...).
loadEnv({ path: path.resolve(import.meta.dirname, "../../../.env") });

const config = apiConfig();
// ...
Bun.serve({ port: config.app.port, ... });
```

Reasoning, since this is the only behavior-affecting change to existing code:

- **Why dotenv at all?** Bun loads `.env` only from the process cwd. Services run from their package dirs under turbo/bun, so the canonical repo-root `.env` was invisible (`apps/backend && bun -e ...` printed `unset` while the identical command at repo root saw the variables — verified empirically). Without a loader, any developer running the backend would hit fail-fast validation with no obvious remedy.
- **Why function-call form?** Static imports hoist, but statement order within the module body guarantees `loadEnv()` runs before `apiConfig()`.
- **Silent no-op when the file is missing** means deployments that inject real env vars behave identically — production secrets stay with the platform/secret manager, never with a committed file.
- **Runtime-restricted**: only this entrypoint (allowed Bun-adjacent bootstrap per ADR-001); library code reads config, never `process.env`.

The net effect: previously-unvalidated implicit defaults became a hard contract. Booting with missing infrastructure vars now produces the full remediation list instead of a half-working server.

---

## 8. Migration scaffold for `db:migrate`

DoD requires `bun run db:migrate` to succeed against composed Postgres with an *empty* migration set. Reality check revealed drizzle-kit had never generated anything: `packages/db/drizzle/` did not exist, and drizzle-orm's migrator failed immediately with `Can't find meta/_journal.json`.

The minimal scaffolding consistent with "databases created empty by compose; Drizzle migrations come later":

```json
// packages/db/drizzle/meta/_journal.json
{ "version": "7", "dialect": "postgresql", "entries": [] }
```

Notes:

- First attempt used `[]`; drizzle iterates `journal.entries`, requiring the envelope form above (second small bug found by running it, see section 9.4).
- With the envelope, migrator output: `⏳ Running database migrations... ✅ Migrations applied successfully!`
- Resulting state verified inside psql: bookkeeping table `drizzle.__drizzle_migrations` exists with **0 rows**, and `\dt` shows no application tables — precisely "creates migrations table; no tables yet".
- Naming note: the step says `_drizzle_migrations`; in drizzle-orm 0.38 the postgres migrator actually creates `drizzle.__drizzle_migrations` (dedicated schema + prefixed name). We treat these as the same requirement; the verification records the exact observed names.
- Zero SQL, zero schema — s-04/s-06 remain untouched owners of real migrations; s-06 will note replacing/growing this scaffold naturally.

One operational observation recorded for later steps: `db:migrate` lives in the package script, so it must be invoked from `packages/db` (turbo filter or `cd packages/db && bun run db:migrate`) — there is no root passthrough yet. `bun run db:migrate` from the root errors with "Script not found", which is expected bun behavior for non-root scripts, not a defect.

---

## 9. Problems discovered during verification and their fixes

Each of these was found by actually bringing the stack up and probing it — worth recording because these behaviors are invisible until you run them.

### 9.1 Temporal healthcheck fails against loopback

Symptom: stack came up, logs showed successful schema setup and namespace registration, yet `arr-temporal` reported `(unhealthy)` and dependent startup aborted.

Debugging: inside the container, `nc -z 127.0.0.1 7233` exited 1, while `nc -z <container-ip> 7233` succeeded — the Temporal server binds its **container IP, not loopback**. (`tctl` inside the image also defaults to 127.0.0.1 and needed an explicit address override.)

Fix: probe the interface the server actually binds:

```yaml
test: ["CMD-SHELL", "nc -z $$(hostname -i) 7233"]
```

(`$$` escapes the dollar from compose interpolation so the shell inside the container performs hostname resolution.)

### 9.2 Redpanda console served on the wrong internal port

Console's default listen port is **8080** internally, so the published `8081:8081` mapping pointed at nothing (probed with wget from inside the container: connection refused on 8081, 200 on 8080). Since the step mandates console at :8081 on the host, fixed by aligning the container side to the published port:

```yaml
SERVER_LISTENPORT: "8081"
```

Chosen over remapping `8081:8080` so what you see in the compose file matches what listens inside the container — fewer surprises when someone debugs with `docker exec`.

### 9.3 First `--wait` run exposed both issues at once

Worth noting: the initial cold run failed exactly as designed — postgres/redpanda went healthy, `temporal` failed its healthcheck, and compose refused to start dependents (UI/console). After fixes 9.1/9.2, a re-run brought all six green. That is the dependency-gating behavior the step asked for, proven by breaking it once.

### 9.4 Drizzle journal format

Covered in section 8: bare `[]` rejected (`{} is not iterable` inside the migrator), envelope `{version, dialect, entries: []}` accepted.

### 9.5 Backend could not see the root `.env`

Two distinct bugs stacked here:

1. Bun does not walk up the directory tree for `.env` (confirmed: same command, different cwd, opposite results). Fixed with explicit dotenv loading (section 7).
2. The loader initially resolved `../../.env` relative to `apps/backend/src` → landed on `apps/.env` (ENOENT caught in isolation with a scratch probe). One more level fixed it: `../../../.env` from `import.meta.dirname`.

Final proof: backend boots past validation using the user's real `.env`, then binds successfully (tested on `PORT=8123` since 8000 was occupied by an unrelated process on the dev machine).

### 9.6 Type system friction (resolved, no runtime impact)

- `"types": ["node"]` in tsconfig requires `@types/node` declared locally → added to devDependencies (the base shared config doesn't provide it).
- base.json enforces NodeNext resolution; the other packages here use bundler-style resolution with extensionless imports, so `packages/config/tsconfig.json` overrides `module: ESNext, moduleResolution: bundler` to match repo-local convention.
- A zod pitfall: `.default(false)` placed **after** a transform chain rejects booleans because zod applies defaults pre-transform at the input type. Restructured `SIMULATE_*` as `enum(["true","false"]).default("false").transform(v => v === "true")` — default at string level, booleanization after. Good example of why the enums stay string-typed until the boundary.

---

## 10. Verification evidence (Definition of Done)

| DoD item | Evidence |
|---|---|
| 7 services healthy ≤ 90s | `bun run infra:up` (= `up -d --build --wait`) exited 0 with all seven `Healthy`; `compose ps` shows every service `(healthy)` |
| Temporal UI :8080 + namespace visible | `curl http://localhost:8080/` → HTTP 200; `tctl namespace describe` → `Name: revenue-recovery, State: Registered` |
| Console :8081 | `curl http://localhost:8081/` → HTTP 200 |
| Frontend :3000 | `curl http://localhost:3000/` → HTTP 200 |
| `db:migrate` vs composed Postgres | Green from `packages/db`; `drizzle.__drizzle_migrations` created, 0 rows, no app tables |
| Typed configs consumed | backend boots through `apiConfig()`; smoke test ran with user's real `.env` |
| `.env.example` updated; no secrets in git | All additions listed in section 5; `git check-ignore .env` confirms tracking hygiene |
| Config validation unit tests | 13/13 passing via `bun run test` |

Repo-wide gates: `bun run check-types` 5/5 packages green · `bun run lint` green · `bun run test` green · `bun run check-docs` 19 links OK.

Bookkeeping closed out per AGENTS.md: `specs/steps/progress.md` marked DONE with evidence and completion-log entry (position advanced to s-03, 2/35 steps), and `docs/TRACEABILITY.md` gained three rows (local infra stack, typed config, mock/failure-injection switches) mapping spec 01 §3/§4 and spec 03 §2/§9 to s-02.

---

## 11. Deviations and judgment calls

Small, deliberate, and traceable:

1. **`src/web.ts` added beyond the four-file tree sketch** — the requirements text itself demands a `webConfig()` preset, so the sketch yields to the requirement list.
2. **Empty-migration journal file (`packages/db/drizzle/meta/_journal.json`)** — without it the DoD migrate check cannot pass at all. Content-free scaffold; s-04+ owns real entries.
3. **Backend entrypoint loads root `.env` via dotenv** — a DX necessity made visible by fail-fast validation; contains no Bun-specific API and no-ops in production.
4. **`workerConfig()` delegates to `apiConfig()`** instead of a narrower slice — documented trade-off; same-server-surface today, split point preserved for least privilege later.
5. **Frontend Docker container (`apps/frontend/Dockerfile`)** — containerized with Next.js standalone output and `.dockerignore` for single-command full-stack boot via `infra:up`.
6. **Port-pinning choices** (`SERVER_LISTENPORT`, healthcheck prober shapes, pinned image tags) are compose-level only; no application semantics changed.

Nothing else in the repository was touched: no spec modifications besides `progress.md`, no drive-by refactors, and the user's existing root `.env` (which points `DATABASE_URL` at a cloud instance) was left exactly as found — worth aligning to the composed Postgres before s-04 work begins.
