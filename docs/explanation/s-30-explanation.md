# s-30 — Security Hardening & Compliance Verification: Implementation Explanation

This document explains, in complete depth, everything that was done to implement `specs/steps/s-30.md`. It is written so that a developer (or future agent) who was not present during implementation can understand every file, every decision, every deviation, and every problem that had to be debugged along the way.

---

## Table of contents

1. [What the step required](#1-what-the-step-required)
2. [Rate-limit policy finalization (`rate-limit-policy.ts`)](#2-rate-limit-policy-finalization)
3. [Abuse protection: `IpBlockService`, guard, admin API, webhook wiring](#3-abuse-protection)
4. [Cross-tenant probe matrix (`tests/security/cross-tenant.probe.test.ts`)](#4-cross-tenant-probe-matrix)
5. [Secret sweep (`scripts/security-sweep.mjs` + sweep test)](#5-secret-sweep)
6. [Log redaction verification (`log-redaction.e2e.test.ts`)](#6-log-redaction-verification)
7. [Dependency audit (`scripts/dependency-audit.mjs`) + digest pins](#7-dependency-audit)
8. [RLS decision (ADR-015)](#8-rls-decision-adr-015)
9. [Docs: checklist, runbooks, dockerignore](#9-docs-checklist-runbooks-dockerignore)
10. [Test runner wiring (`test:security`, vitest `security` project)](#10-test-runner-wiring)
11. [Problems discovered during verification and their fixes](#11-problems-discovered-during-verification-and-their-fixes)
12. [Verification evidence (Definition of Done)](#12-verification-evidence-definition-of-done)
13. [Deviations and judgment calls](#13-deviations-and-judgment-calls)

---

## 1. What the step required

Step s-30 consolidates every scattered security requirement into one auditable pass against spec 03 §11 (eight acceptance criteria), spec 01 §22 (tenant isolation, RBAC, signatures, encrypted secrets, least-privilege creds, PII minimization, audit logs, rate limiting, CSRF), and the spec 02 §14 boundary diagram. The Definition of Done checklist:

- `docs/SECURITY-CHECKLIST.md` complete; every row evidence-linked
- Cross-tenant probe suite generated & green across full route inventory
- Secrets sweep + log redaction jobs in CI
- Rate-limit/abuse policies finalized + tested
- RLS decision recorded (ADR-015) and implemented-or-deferred-with-rationale
- Rotation runbooks published

Everything below maps to those items. No feature work, no refactors outside this scope — except two pre-existing test failures found during verification, documented in section 11.

---

## 2. Rate-limit policy finalization

**File:** `apps/backend/src/plugins/rate-limit-policy.ts` (new)

Before s-30, rate limits were ad-hoc: webhooks 600 and `/events` 60 existed as inline configs, login had a bespoke bucket, and everything else fell through to a global 1000/min keyed by IP. The step mandates a finalized per-class table, so the policy now lives in exactly one module:

```ts
export const RATE_LIMIT_POLICIES = {
  webhook:        { max: 600, timeWindow: "1 minute" },
  authLogin:      { max: 5,   timeWindow: "1 minute" },
  read:           { max: 120, timeWindow: "1 minute" },
  events:         { max: 60,  timeWindow: "1 minute" },
  providerStatus: { max: 30,  timeWindow: "1 minute" },
  demo:           { max: 60,  timeWindow: "1 minute" },
};
```

with `rateLimitFor(class)` producing the Fastify `config.rateLimit` fragment and `rateLimitKeyGenerator(request)` implementing caller-identity keying: truncated SHA-256 of the raw `Authorization` header when present (per-key budgeting for dashboard polling and machine clients), else client IP (webhooks, login). The raw secret never leaves the function — only the 32-char digest becomes the counter key, and it is never logged.

Two deliberate non-obvious calls:

1. **Login stays on its bespoke bucket.** `POST /auth/login` enforces 5/min per **IP+email-hash** inside `loginUser` (`modules/auth/service.ts`). A generic route-level `max: 5` would key per IP and lock out every user behind one NAT egress after five logins. The code comment on the route says exactly this, and the checklist records the bucket as the authoritative `authLogin` enforcement (proven by the existing `rate-limit-auth.test.ts`, re-run in `test:security`).
2. **`POST /ai/decide` rides the `events` class (60/min).** The step's table has no LLM row; decide is authenticated, expensive (tokens cost money), and ingestion-shaped, so 60/min with a comment is the honest classification rather than inventing a new row.

**Route edits:** `config: { rateLimit: rateLimitFor("read") }` was added to every authenticated read route (risks ×2, customers context, cases ×4, payments `GET :id`, messages ×2, human-tasks ×2, promises ×2, outcomes ×2, analytics ×6, AI decisions ×2, policies list + versions, audit, admin lists), `rateLimitFor("demo")` to all demo endpoints, and `rateLimitFor("events")` to `POST /ai/decide`. Pre-existing tighter configs (`/events` 60, webhooks 600, payment status 30) were kept and are now named by the same table.

**Plugin changes** (`plugins/rate-limit.ts`): accepts `keyGenerator` + `onLimitExceeded`, and `classifyRateLimitRoute(url)` maps request paths to policy classes for the new `security_ratelimit_hits_total{route_class}` counter. `app.ts` wires the key generator and the metrics hook (both fenced in try/catch — metrics must never break request handling). New counters (`security_ratelimit_hits_total`, `security_signature_failures_total`, `security_ip_blocks_total` + record helpers) live in `packages/observability/src/metrics.ts`; `DomainErrorCodes.IP_BLOCKED` + `IpBlockedError` (429 + `Retry-After`) in `lib/errors.ts`, with explicit 429 handling in the error-handler plugin.

---

## 3. Abuse protection

**Files:** `apps/backend/src/modules/security/ip-block.service.ts`, `webhook-abuse.ts` (new); `apps/backend/src/modules/admin/ip-blocks.routes.ts` (new); edits to all four webhook surfaces.

The step's abuse rule — *repeated 401 signature failures → temporary IP block (Redis)* — is implemented as `IpBlockService`:

- `recordSignatureFailure(ip, provider, log)`: `INCR sec:sigfail:<ip>` with 600 s expiry; at 10 failures, `SET sec:ipblock:<ip> EX 600`. Emits the WARN security event (`event=security.ip_blocked`, ip, provider, failures, ttl) and `security_ip_blocks_total{reason}`. Fully Redis-backed with an in-memory fallback (same thresholds) so abuse protection survives Redis outages and works in tests.
- `checkIpBlock` pre-handler (mounted on Stripe, Razorpay, WhatsApp, and both email webhook routes): throws `IpBlockedError` → `429 IP_BLOCKED` + `Retry-After`, per the step's error-contract requirement.
- `recordWebhookAuthFailure(fastify, request, provider)` helper: never throws (abuse accounting must not break webhook responses); no-ops gracefully when the service isn't decorated (standalone plugin tests).
- ADMIN clear path: `GET /admin/ip-blocks` (inspect) and `DELETE /admin/ip-blocks/:ip` (clear; IP-format validated → 422 otherwise), both ADMIN-only, registered under `/admin` in `lib/routes.ts`.

Stripe/Razorpay routes wrap `processInboundWebhook` in try/catch and record on `INVALID_SIGNATURE`/401; WhatsApp/email record on their direct 401/403 replies (their 401s are returned, not thrown). WhatsApp's bare `request.log.warn("Invalid WhatsApp webhook signature")` became a structured WARN via the same helper, satisfying the step's "security events logged WARN with structured keys."

**Reliability properties:** 10-minute TTL on both counters and blocks (step-mandated); providers retry non-2xx, so blocked-then-retried deliveries are delayed, never lost; the rotation companion runbook documents the interplay (section 9).

---

## 4. Cross-tenant probe matrix

**File:** `tests/security/cross-tenant.probe.test.ts` (36 tests, all green)

"Generated from route inventory" is implemented as data: `detailProbes` (14 path-id swaps), `listProbes` (12 endpoints), plus body/query, write, and RBAC spot probes — each entry names method + URL template, and a loop executes them all against a two-tenant seed graph (tenant A owns customer, payment, risk, case, decision, policy rule, message, human task, promise-to-pay, outcome, audit log, user, API key; tenant B owns a bare customer).

Semantics per probe kind:

- **[detail]** tenant-B key + tenant-A id → `404`, and the 404 body must not echo the foreign object. Covers risks, customer context, AI decisions, cases (+timeline, +outcome), payments (+live status — 404 fires before provider fan-out), messages, human tasks, promises, outcomes, policy versions, `POST /cases/:id/pause` (guarded-transition 404), `POST /ai/decide` with foreign `case_id` (404 before any LLM call — decide validates the case first), and `PATCH /policies/:id` (404 without mutation).
- **[body]** `POST /events` with `tenant_id` of A under B's key → `403` (request-supplied tenant ids are rejected, never trusted).
- **[list]** twelve `GET` endpoints → `200` with zero tenant-A markers in the body (including `/audit`, `/admin/users`, `/admin/api-keys`, `/analytics/summary`).
- **Owner sanity first:** three `200`-as-owner assertions prove the probes are meaningful (a 404-for-everyone bug would fail these, not the probes).
- **RBAC spot checks:** unauthenticated → 401; VIEWER session on `/audit` and `POST /policies` → 403; `/auth/me` binds key B to tenant B.

All repository lookups are tenant-first by signature, so every 404 is the *absence of a row in the caller's scope* — never a data leak, never an existence oracle beyond "not yours."

---

## 5. Secret sweep

**Files:** `scripts/security-sweep.mjs` (new, `bun run security:sweep`), `tests/security/secrets.sweep.test.ts`.

Design decisions that matter:

1. **Scans `git ls-files`, not the working tree.** Local-only secrets (`infra/docker/.env`, root `.env`) are untracked + gitignored by design; scanning the tree would fail every developer machine. Tracked files are what ships — that is the correct gate boundary.
2. **Plus the built bundle + docker hygiene.** When `apps/frontend/.next/{standalone,static}` exists (CI builds first), all shippable JS/JSON/HTML/CSS is scanned — the "no provider secret in frontend" proof. Every `.dockerignore` (root + `infra/docker/`, the latter created this step) must exclude `.env*` and `.git`, or the gate fails — the "docker context" proof. (`--skip-bundle` / `--bundle-dir` flags exist for local speed.)
3. **Placeholder discipline.** `.env.example` must name variables without tripping the gate: values containing `...`, `xxx`, `***`, `your-`, `example`, `changeme`, `placeholder`, or English-word bodies (`secret`, `integration`, `fixture`, `synthetic`, `dummy`) are ignored — provider-issued secrets are random alphanumerics and never contain those words. Vetted synthetic fixtures (sequential-digit test keys, the Razorpay dev-fallback literal, the frozen s-30 spec prose naming `BEGIN PRIVATE KEY`) are exact-value allowlisted with per-entry rationale. The first sweep run surfaced 13 hits; each was manually vetted (section 11) before allowlisting — none is a live credential and none is tracked outside its fixture.
4. **Exit codes:** 0 clean, 1 leak (fails build), 2 environment error.

---

## 6. Log redaction verification

**File:** `tests/security/log-redaction.e2e.test.ts` (5 tests, green, no DB)

Plants unique per-run known-secret values (`sk_test_…`, `whsec_…`, `rzp_test_…`, `rrk_…`, session token, password — constructed at runtime so the sweep never sees a literal), then:

- emits them through the real pino logger + request serializer and asserts **zero occurrences** of any planted value, with `[REDACTED]` present and safe fields intact;
- asserts the audit `scanForPii` flags the planted Stripe key as `SECRET` and `redactPii` output is clean (detection *and* sanitization both proven);
- records HTTP/ratelimit/signature metrics and asserts the Prometheus exposition contains no planted value and does expose the new security counters (metric labels are static route/provider strings — they cannot smuggle secrets).

---

## 7. Dependency audit

**File:** `scripts/dependency-audit.mjs` (new, `bun run security:audit`)

Three checks: `bun.lock` exists; both Dockerfiles install `--frozen-lockfile` **and** pin every `FROM` by digest (fails otherwise); then `bun audit --json` (npm fallback) fails on `critical` (threshold via `AUDIT_FAIL_LEVEL`). Current state: clean, 0 critical findings. The lockfile-diff policy (lockfile must move with every dependency change; images build frozen so staleness fails early; reviewers confirm diff-vs-declaration match) is documented in the checklist — automation covers reproducibility, review covers intent.

**Digest pins** (resolved via `docker buildx imagetools inspect`, tag kept for readability): `oven/bun:1.4-alpine@sha256:d888c0ae…` (backend build+runner, frontend build) and `node:20-alpine@sha256:fb4cd12c…` (frontend runner).

---

## 8. RLS decision (ADR-015)

**File:** `docs/adr/ADR-015-rls-decision.md` — **defer with rationale**, which the step explicitly allows ("implemented-or-deferred-with-rationale"). The core argument: production pools in transaction mode (ADR-003/004), where `SET LOCAL app.tenant_id` cannot survive checkout/checkin — session-variable RLS would either break pooling or, worse, leak context across checkouts and *create* the cross-tenant bug it is meant to prevent. With a single pooled writer role, app-layer scoping (tenant-first repository signatures + `getTenantScope` + per-tenant indexes + the 36-probe suite) remains the enforcement point, following the s-25 precedent of DB enforcement only where no session state is needed (append-only triggers). The ADR names three concrete revisit triggers and includes the migration sketch so the decision is reversible without re-discovery.

---

## 9. Docs: checklist, runbooks, dockerignore

- **`docs/SECURITY-CHECKLIST.md`** — the signed artifact: all 10 step-mandated rows green with implementation → test → status; §11/§22/§14 mappings; the finalized rate-limit table; abuse-rule parameters; demo-prod posture; CSRF review (SameSite=Lax + JSON-only POSTs, token approach deferred with the "no cookie form exists" rationale and explicit revisit triggers); least-privilege summary; dependency policy; §14 boundary table; s-34 alert thresholds; findings closed; residual risks.
- **`docs/runbooks/webhook-secret-rotation.md`** (singular, new) — companion to the s-10 plural runbook (left untouched): abuse-block interplay during rotation, verification-signal table, ADMIN inspect/clear procedure, post-revocation unblocking. Thin by design to avoid content drift.
- **`docs/runbooks/least-privilege-credentials.md`** (new) — per-credential minimum-scope table (restricted Stripe keys, per-endpoint webhook secrets, sending-only email keys, spend-capped LLM keys, `app_rw`/`audit_writer`, Redis ACL prefixes for prod), machine-vs-human principal rules, rotation summary.
- **`infra/docker/.dockerignore`** (new) — mirrors root exclusions for contexts rooted in `infra/docker` (`.env*`, `.git`, keys, node_modules).

---

## 10. Test runner wiring

- `vitest.config.ts` gains a `security` project (`tests/security/**/*.test.ts`, 60 s timeouts for DB-backed probes).
- Root `package.json`: `test:security` runs the four new suites **plus** the ten prior security-relevant suites in one command (s-09 auth + matrix + lockout, s-10 webhooks, s-11 events, s-13 context, s-15 adversarial, s-16 policy, s-19 messaging, s-25 audit timeline) — the regression re-runs the step demands, consumable by s-33 CI. `security:sweep` and `security:audit` are the CI gates.
- Root `devDependencies` gain `fastify`, `pino`, and `@repo/{db,integrations,observability}` (`workspace:*`): the repo uses isolated installs, so root-level tests cannot see backend-only packages otherwise. Only *direct* bare imports needed root resolution; transitive backend imports still resolve locally. `bun install` produced no other changes.

---

## 11. Problems discovered during verification and their fixes

1. **Sweep triage (13 hits, all benign).** Full-shaped test vectors in fixtures (`sk_live_9999…`, `sk_test_1234…`, `whsec_integration_…`, `rrk_live_super_secret_…`, `rzp_test_secret` ×4 incl. the Razorpay adapter dev-fallback default), logger-test vectors, and the s-30 spec prose itself. Each vetted by reading the exact line; disposition: placeholder-hint words + exact-value allowlist with rationale. The Razorpay dev-fallback default got extra scrutiny: synthetic words, unreachable in live mode (`@repo/config` fail-fast requires env) — allowlisted, recorded as reviewed in the checklist.
2. **`infra/docker/.env` holds a real Neon credential.** Verified untracked (`git ls-files` shows only `.env.example`) and gitignored, excluded from images by both dockerignores — no leak. Recorded in the checklist with the rotate-if-shared advisory. The sweep test asserts this file stays untracked so a future `git add -f` trips review, not silence.
3. **`POST /demo/mock/payments/:key/next-outcome` was unauthenticated.** Any caller could script provider outcomes in mock mode. Closed with `demoGuard` + demo rate limit; the one existing caller test now authenticates (ADMIN session cookie), plus a new 401 regression test. Documented as finding #1 in the checklist.
4. **s-27 golden-month date-bomb (pre-existing, not s-30).** `analytics-integration` section 6 seeds decisions/actions with `createdAt = now` against a hardcoded August 2026 window — green on 08-29, red for anyone running after 08-31 (`expected 0 to be 4`). Fixed minimally: optional `createdAt` passthrough on `createDecision`/`insertAction` (backward-compatible, test/seed use only) + August timestamps on the eight seeds. No query or app behavior touched.
5. **Orphaned `recovery-test` tenant (pre-existing shared-DB debris).** `recovery-constraints.test.ts` failed setup on `policy_rules_code_unique` from an interrupted run's leftovers. Cleaned with the test file's own cleanup order; suite is 18/18 green again. Lesson recorded for s-31: shared-DB suites need idempotent seeding.
6. **Worker-suite timeouts under full parallel load (pre-existing flake).** Four Temporal files hit 30 s timeouts in the full run; each passes in isolation (7/7, 8/8, 9/9, 13/13). Untouched by this diff (nothing in `services/worker` changed); final full run left exactly one such flake, green on isolated re-run. Noted for s-31, which owns resilience/chaos.
7. **Root tests can't resolve backend-only packages** (isolated installs) — solved with root devDeps (section 10), not with fragile deep-relative imports.

---

## 12. Verification evidence (Definition of Done)

| DoD item | Evidence |
|---|---|
| `docs/SECURITY-CHECKLIST.md` complete; every row evidence-linked | File exists; 10/10 rows ✅ with implementation → test → status; `bun run check-docs` 48 links OK |
| Cross-tenant probe suite generated & green across full route inventory | `tests/security/cross-tenant.probe.test.ts`, 36/36 green (14 detail + body + 12 list + sanity + RBAC) |
| Secrets sweep + log redaction jobs in CI | `bun run security:sweep` clean (tracked files + 27 bundle files + dockerignores); sweep test 7/7; redaction 5/5; scripts wired for s-33 CI |
| Rate-limit/abuse policies finalized + tested | `RATE_LIMIT_POLICIES` table; abuse suite 9/9 incl. end-to-end 401→429 `IP_BLOCKED`→ADMIN-clear→401; login lockout re-run green |
| RLS decision recorded (ADR-015) and implemented-or-deferred-with-rationale | `docs/adr/ADR-015-rls-decision.md`, deferred with pooler rationale + triggers + migration sketch |
| Rotation runbooks published | Plural (s-10, untouched) + singular companion + least-privilege doc; all linked from checklist |
| Gates | `bun run check-types` 12/12 · `bun run lint` green · `bun run test:security` 14 files / 165 tests green · `bun run test` 967/968 (1 Temporal load-flake, green in isolation) · `bun run check-docs` green · `bun run security:audit` clean |

---

## 13. Deviations and judgment calls

1. **`POST /ai/decide` classified as `events` (60/min)** rather than a new policy row — documented in code and checklist; LLM spend protection without inventing policy the step didn't ask for.
2. **Login has no route-level `max`** — the IP+email bucket is strictly stronger; a route-level cap would lock out NAT-sharing users. Documented, not silently omitted.
3. **Root devDeps added** (`fastify`, `pino`, `@repo/*`) — required by isolated installs for root-level tests; minimal set, no version churn (`bun install` reported no other changes).
4. **Incidental pre-existing fixes** (analytics `createdAt` passthroughs + seed dates; orphan tenant cleanup) — outside strict scope but required for a green tree; each is test/seed-only except two backward-compatible optional repo fields, and each is called out here and in the progress log rather than buried.
5. **Digest values resolved live** via `docker buildx imagetools inspect` and pinned with tags retained for readability; the audit script fails the build if any `FROM` loses its digest.
6. **CSRF tokens and RLS deferred with written rationale + revisit triggers** — the step permits deferral for RLS explicitly; CSRF got the same treatment since no cookie form exists to protect. Both are one-paragraph reversals, not open questions.
7. Nothing else was touched: no spec edits besides `progress.md`, no app behavior change beyond the step's abuse/rate-limit/demo-guard scope, no drive-by refactors.
