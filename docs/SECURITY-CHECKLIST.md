# Security Checklist with Evidence (s-30)

Consolidated verification pass over spec 03 §11, spec 01 §22, and spec 02
§14. Every row is green with a pointer to the implementation and the test
that proves it — nothing in this file relies on "we were careful."

- Signed off: step s-30, 2026-09-06
- Aggregate regression command: `bun run test:security`
- Gates: `bun run security:sweep` (fails build on secret hits),
  `bun run security:audit` (fails on critical advisories + unpinned images)
- RLS decision: [ADR-015](./adr/ADR-015-rls-decision.md) (defer, with rationale)
- Rotation: [runbooks/webhook-secrets-rotation.md](./runbooks/webhook-secrets-rotation.md),
  [runbooks/webhook-secret-rotation.md](./runbooks/webhook-secret-rotation.md),
  [runbooks/least-privilege-credentials.md](./runbooks/least-privilege-credentials.md)

## 1. Step-mandated checklist (all green)

| # | Check | Implementation | Test file(s) | Status |
|---|---|---|---|---|
| 1 | No provider secret in frontend bundle | Only `NEXT_PUBLIC_*` crosses the boundary (`packages/config` `webConfig`); sweep scans tracked files + built `.next` bundle + docker contexts | `tests/security/secrets.sweep.test.ts`, `scripts/security-sweep.mjs` | ✅ green (bundle scan clean, 27 files at s-30 close; 10,334 at s-35 — see `docs/RELEASE-v0.1.0.md`) |
| 2 | No raw secret in logs | Pino `redact` paths + request serializer (`apps/backend/src/plugins/logger.ts`, `@repo/observability`); planted-secret run asserts zero occurrences | `tests/security/log-redaction.e2e.test.ts`, `apps/backend/src/tests/security.test.ts` | ✅ green |
| 3 | Webhook signatures validated | Constant-time HMAC on every surface (Stripe ±5 m window, Razorpay, WhatsApp `x-hub-signature-256`, email token); verification precedes any processing | `apps/backend/src/tests/webhooks.test.ts`, `apps/backend/src/tests/messaging-integration.test.ts` (re-run in `test:security`) | ✅ green |
| 4 | Tenant context mandatory | `getTenantScope` throws `TENANT_CONTEXT_MISSING` (400); tenant never read from unverified params | `tests/security/cross-tenant.probe.test.ts` (36 probes) | ✅ green |
| 5 | Role checks on admin endpoints | `requireRole` pre-handlers; `/audit` ADMIN-only; human-task decisions session-only | `apps/backend/src/tests/auth.test.ts` (RBAC matrix re-run), probe file RBAC spot checks | ✅ green |
| 6 | LLM context allowlisted | Field allowlist + PII masking + 8 KB budget (`modules/customers`); prompt templates versioned; no free-text customer content reaches providers | `apps/backend/src/tests/customer-context.test.ts`, `apps/backend/src/tests/ai-governance-adversarial.test.ts` (re-runs) | ✅ green |
| 7 | Outbound actions pass policy | Policy gate before execution + defense-in-depth contact-cap rechecks in messaging; negative-path suites | `apps/backend/src/tests/policy-integration.test.ts` (re-run) | ✅ green |
| 8 | Audit records immutable to normal operators | DB triggers reject UPDATE/DELETE; `app_rw`/`audit_writer` roles; ADMIN read-only compliance endpoint | `apps/backend/src/tests/audit-timeline-integration.test.ts` (re-run) | ✅ green |
| 9 | Rate limiting active per policy | Per-class policy table (§3) enforced by `@fastify/rate-limit` + login bucket + IP-block abuse rule | `tests/security/abuse-limits.integration.test.ts`, `apps/backend/src/tests/rate-limit-auth.test.ts` (re-run) | ✅ green |
| 10 | Sessions/keys storage hashed | SHA-256 key/token hashes; argon2id passwords; 60 s Redis hot-path cache, 12 h sliding sessions | `apps/backend/src/tests/auth.test.ts` (re-run) | ✅ green |

## 2. Spec 03 §11 acceptance criteria → rows above

| §11 criterion | Row(s) |
|---|---|
| No provider secret in frontend | 1 |
| No raw secret in logs | 2 |
| Webhook signatures validated | 3 |
| Tenant context mandatory | 4 |
| Role checks on admin endpoints | 5 |
| LLM context allowlisted | 6 |
| Outbound actions pass policy | 7 |
| Audit records immutable to normal operators | 8 |

(Rate limiting, sessions/keys storage, CSRF, and dependency hygiene come
from spec 01 §22 and are covered in rows 9–10 and §§3–7 below.)

## 3. Finalized rate-limit policy (per route class)

Single source of truth: `apps/backend/src/plugins/rate-limit-policy.ts`
(`RATE_LIMIT_POLICIES`), asserted by `abuse-limits.integration.test.ts`.

| Route class | Budget | Keying | Enforced in |
|---|---|---|---|
| Webhooks (`/webhooks/*`: Stripe, Razorpay, WhatsApp, email) | 600/min | IP | route `config.rateLimit` |
| Auth login (`POST /auth/login`) | 5/min | IP + email-hash (bespoke bucket, lockout backoff) | `modules/auth/service.ts` (stronger keying than the generic limiter; see code comment) |
| Authenticated reads (cases, risks, customers, payments, messages, tasks, promises, outcomes, analytics, AI decisions, policies, audit, admin lists) | 120/min | API-key digest, else IP | route `config.rateLimit` + `rateLimitKeyGenerator` |
| Event ingestion (`POST /events`, `POST /ai/decide`) | 60/min | key/IP | route `config.rateLimit` |
| Provider status polling (`GET /payments/:id/status`) | 30/min | key/IP | route `config.rateLimit` (tighter: live fan-out) |
| Demo/simulation (`/demo/*`) | 60/min | key/IP | route `config.rateLimit` + `demoGuard` + prod omission/410 |

429s carry `Retry-After` (plugin `errorResponseBuilder`, `IpBlockedError`,
central error handler). Rejections increment
`security_ratelimit_hits_total{route_class}` for s-34 alerting.

### Abuse rule: signature-failure → temporary IP block

- 10 failures/IP/10 min → 10-minute block (`IpBlockService`,
  Redis-backed with in-memory fallback; `checkIpBlock` guard on all webhook
  surfaces). Rationale for 10: absorbs rotation overlap and provider retry
  bursts without letting credential-stuffing run free.
- Blocked callers get `429 IP_BLOCKED` + `Retry-After`; every block logs
  WARN with structured keys (`event=security.ip_blocked`, ip, provider,
  failures) and increments `security_ip_blocks_total{reason}`.
- ADMIN clear path: `GET /admin/ip-blocks`, `DELETE /admin/ip-blocks/:ip`
  (`apps/backend/src/modules/admin/ip-blocks.routes.ts`).
- Rotation interplay documented in
  [runbooks/webhook-secret-rotation.md](./runbooks/webhook-secret-rotation.md).

### Demo disabled in production

Three layers: routes omitted from registration when
`NODE_ENV=production && MOCK_PROVIDERS=false` (`lib/routes.ts`); runtime
`410 MOCK_DISABLED` guard; `demo` scope / OPERATIONS+ role check
(`demoGuard`). s-30 additionally placed the previously unauthenticated
`POST /demo/mock/payments/:key/next-outcome` behind `demoGuard` (mock
scripting without auth is an abuse primitive) and updated
`payment-execution-integration.test.ts` accordingly.

## 4. Tenant isolation proof (spec 02 §15, s-30 req 1)

- `tests/security/cross-tenant.probe.test.ts`: 36 probes over the full
  route inventory — 14 path-id swaps + `POST /ai/decide` + `PATCH /policies`
  (404, no mutation), `POST /events` tenant mismatch (403), 12 list
  endpoints (200, zero foreign rows), owner-sanity positives, and
  auth/RBAC spot checks. Green.
- RLS evaluation: **deferred with rationale** —
  [ADR-015](./adr/ADR-015-rls-decision.md). App-layer scoping (tenant-first
  repository signatures + `getTenantScope` + per-tenant indexes) remains the
  enforcement point; pooler transaction mode makes session-variable RLS
  unsafe at MVP.

## 5. CSRF posture (s-30 req 5)

Reviewed, documented, token approach deferred with rationale:

- Session cookie `rr_session` is `httpOnly`, `SameSite=Lax`, `Secure` in
  production, 12 h sliding (`modules/auth/routes.ts`).
- Every state-changing endpoint is JSON-only (`application/json`
  content-type enforcement on webhooks; JSON body parsers elsewhere) —
  `SameSite=Lax` already blocks cross-site top-level GETs, and JSON-only
  POSTs cannot be forged by simple cross-site forms.
- No cookie-mutating HTML form exists anywhere (dashboard uses `fetch`
  with JSON; login/logout are JSON APIs), so double-submit tokens would
  add machinery with no threat to bind to.
- **Revisit if**: a cookie-authenticated HTML form is ever added, or
  `SameSite` is relaxed — then implement double-submit CSRF tokens before
  shipping the form.

Re-verified without behavior change: `modules/auth/routes.ts` still sets `rr_session` with `httpOnly` + `sameSite: "lax"` (Secure outside localhost in production) on both the login-set and logout-clear paths, and `plugins/cors.ts` keeps an explicit origin allowlist with `credentials: true` (no wildcard reflection, non-listed origins safely rejected); state-changing endpoints remain JSON-only so cross-site simple-form forgery has no foothold, no cookie-mutating HTML form has been added since s-30, and the token-CSRF-deferred posture therefore stands as accepted.

## 6. Least-privilege credentials & rotation (s-30 req 7)

- Per-provider minimum-scope table:
  [runbooks/least-privilege-credentials.md](./runbooks/least-privilege-credentials.md)
  (restricted Stripe keys, per-endpoint webhook secrets, sending-only
  email keys, spend-capped LLM keys, `app_rw`/`audit_writer` DB roles,
  Redis ACL prefixes for prod).
- Rotation runbooks:
  [webhook-secrets-rotation](./runbooks/webhook-secrets-rotation.md)
  (procedure) +
  [webhook-secret-rotation](./runbooks/webhook-secret-rotation.md)
  (abuse-block interplay, verification signals, ADMIN clear path).

## 7. Dependency hygiene (s-30 req 6)

- `bun run security:audit` (`scripts/dependency-audit.mjs`): asserts
  `bun.lock` exists, Dockerfiles install `--frozen-lockfile` with
  **digest-pinned** base images (verified this step), then runs the
  package-manager audit and fails on `critical` (threshold via
  `AUDIT_FAIL_LEVEL`). Current state: clean, 0 critical findings.
- Base images pinned this step:
  `oven/bun:1.4-alpine@sha256:d888c0ae…` (backend build+runner, frontend
  build), `node:20-alpine@sha256:fb4cd12c…` (frontend runner).
- Lockfile diff policy: every dependency change must keep `bun.lock` in
  sync — images build with `--frozen-lockfile`, so a stale lockfile fails
  before this gate; reviewers confirm the lockfile diff matches the
  declared dependency change.

## 8. Spec 02 §14 boundary verification

| Boundary | Enforcement | Evidence |
|---|---|---|
| Provider → gateway (webhooks) | HMAC per provider, 600/min/IP, IP-block on 401 bursts, JSON-only | rows 3, 9; abuse suite |
| Dashboard → APIs | session/API-key auth, RBAC per route, 120/min/key, CORS allowlist, `SameSite=Lax` cookies | rows 4, 5, 9; §5 |
| Backend → providers | Credentials confined to `packages/integrations`; idempotent adapters; spend-capped LLM key | row 7; §6 |
| Backend → Temporal/bus | Scoped clients via `@repo/config`; tenant-partitioned events | s-11/s-20 suites |
| Any → PostgreSQL | Single pooled role; tenant-first repos; audit append-only triggers; RLS deferred per ADR-015 | row 4, 8; ADR-015 |
| Any → Redis | Advisory-only data (ADR-007); namespaced keys with TTLs; degrades safe | s-06/s-31 |

## 9. Observability & s-34 handoff

Security signals already emitted (WARN with structured keys +
Prometheus): `auth_failures_total{reason}`, `webhook_deliveries_total{provider,status}`,
`security_signature_failures_total{provider}`,
`security_ratelimit_hits_total{route_class}`,
`security_ip_blocks_total{reason}`. Suggested s-34 alert thresholds:
signature-failure burst (> 20/5 min per provider), any `ip_blocks_total`
increase, `ratelimit_hits_total` spike on `auth` class, and
`invalid_signature` share of webhook deliveries > 5% over 10 min.

## 10. Findings closed during this pass

1. `POST /demo/mock/payments/:key/next-outcome` accepted unauthenticated
   mock scripting → placed behind `demoGuard` + demo rate limit; existing
   test updated to authenticate, plus a new 401 regression test.
2. Thirteen sweep hits triaged: all synthetic fixtures/prose → covered by
   documented placeholder rules + vetted exact-value allowlist in
   `scripts/security-sweep.mjs`. No live secret is tracked by git.
3. `infra/docker/.env` holds a real dev Neon credential: **untracked and
   gitignored** (verified via `git ls-files`), excluded from images by
   both `.dockerignore` files — no leak, but rotate it if it was ever
   shared, and never copy it into tracked files.
4. Razorpay adapter dev-fallback literals (`rzp_test_key`/`rzp_test_secret`)
   reviewed: synthetic words, unreachable in live mode (`@repo/config`
   fail-fast requires env); allowlisted with rationale.

## 11. Residual risks (accepted / owned by later steps)

- RLS deferred (ADR-015) — revisit on multi-role DB access.
- CSRF tokens deferred while no cookie form exists (§5).
- `/metrics` is unauthenticated (Prometheus scraping; s-34 to restrict to
  private network / add scrape auth).
- Re-verified: `GET /metrics` remains unauthenticated on the app port (no auth guard in `modules/meta/routes.ts`) — it MUST stay network-restricted (private SG/VPC-only ingress, never a public LB route) before any public exposure.
- Redis has no AUTH in local compose (loopback-only); prod requires ACLs (§6).
- `bun audit` availability varies by environment; s-33 CI must run
  `security:audit` with a pinned auditor and fail the pipeline on breach.
