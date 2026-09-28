# Engineering Conventions

Binding rules for all code in this repository. Later steps inherit these; changes require a new ADR or an explicit edit recorded in the roadmap progress log. Companion docs: [`ARCHITECTURE.md`](./ARCHITECTURE.md), [`TRACEABILITY.md`](./TRACEABILITY.md), decision records under [`adr/`](./adr/).

## 1. Module layout

### Backend (`apps/backend`)

- Route modules follow the suffix pattern:
  - `*.controller.ts` — route definitions + JSON Schemas (no business logic)
  - `*.service.ts` — business logic; owns transaction boundaries
  - `*.types.ts` — request/response/domain types for the module
- Cross-cutting Fastify concerns live in `apps/backend/src/plugins/` (authn, rbac, rateLimit, audit, otel, errorHandler).
- Repositories (all SQL) live in `packages/db/src/repositories` — controllers/services never write raw queries inline.

### Packages

- `packages/domain` owns entities, enums, state machines, the event envelope, and the action catalog. It must not import from apps, db, or frameworks (spec 02 §16).
- `packages/config` is the only place `process.env` is read; everything else consumes typed config.
- `packages/integrations` is the only place provider credentials are reachable.
- Worker code (`services/worker`) splits into `workflows/` (deterministic) and `activities/` (side effects); no external network calls inside workflow code.

## 2. Naming

| Thing | Convention | Example |
|---|---|---|
| Files | kebab-case | `recovery-case.service.ts` |
| TS variables/functions | camelCase | `calculateRiskScore` |
| TS types/classes/enums | PascalCase | `RecoveryCase`, `RiskBand` |
| Constants | SCREAMING_SNAKE | `MAX_PAYMENT_RETRIES` |
| DB tables/columns | snake_case | `recovery_cases.amount_at_risk` |
| Event types | dot-separated lowercase `<domain>.<event>` | `payment.failed`, `invoice.overdue` |
| Action catalog values | SCREAMING_SNAKE | `RETRY_PAYMENT`, `SEND_WHATSAPP` |
| Case status values | SCREAMING_SNAKE | `IN_PROGRESS`, `POLICY_REVIEW` |
| Error codes | SCREAMING_SNAKE stable strings | `TENANT_CONTEXT_MISSING` |
| Package names | `@repo/*` scope | `@repo/domain`, `@repo/db` |

## 3. Money (ADR-009)

- Integer minor units (paise/cents) in `bigint` columns; ISO-4217 `currency CHAR(3)` beside every amount. Never floats — not in DB, not in TS, not in JSON payloads.
- Domain layer exposes branded integer money types; formatting to display strings happens only at the presentation edge via the shared formatter in `@repo/domain`.

## 4. Time (ADR-011)

- Store UTC `timestamptz`; expose ISO-8601 UTC strings on APIs.
- Business-day math uses the tenant's timezone only inside dedicated date-math utilities; results are stored back as UTC instants.
- Timers in workflows are relative durations anchored to decision time unless policy demands wall-clock.

## 5. Identifiers (ADR-010)

- Business PKs: UUIDv4 via `gen_random_uuid()`.
- Append-only logs: additional `bigserial` ordering column.
- Human case number: `RC-{per-tenant sequence}`, display/search only — never a join or FK.

## 6. Errors

- Domain error classes carry stable machine codes. Non-2xx responses always use the envelope:

```json
{
  "error": {
    "code": "TENANT_CONTEXT_MISSING",
    "message": "human readable",
    "details": { }
  }
}
```

- The central Fastify error handler maps domain error classes → HTTP status; controllers never hand-build error bodies.
- Unknown/unexpected errors map to `500` with code `INTERNAL` (alias `INTERNAL_ERROR`); internals are logged, never leaked to clients.
- Validation failures use code `VALIDATION` (alias `VALIDATION_FAILED`) with field details.
- Note (s-07 audit G-07-1, non-breaking): the canonical wire codes implemented in `apps/backend/src/lib/errors.ts` + `apps/backend/src/plugins/error-handler.ts` are `VALIDATION` (422) and `INTERNAL` (500). `VALIDATION_FAILED` and `INTERNAL_ERROR` are accepted aliases for the same cases (used in worker error taxonomy and older docs) and MUST be treated as equivalent by clients. New code MUST emit `VALIDATION`/`INTERNAL`; never introduce a third variant.

## 7. Logging

- Structured JSON via pino (wired through `packages/observability`).
- Mandatory fields when present: `correlation_id`, `tenant_id`, `case_id`.
- Redaction: never log secrets (`sk_*`, `whsec_*`, API keys, tokens) or full card/customer PII. Log PII against an explicit allowlist only; default is deny.
- Log levels: `error` (needs action), `warn` (degraded but continuing), `info` (state transitions), `debug` (developer detail; off in prod).

## 8. Timeouts & retries

- Every async external call (LLM, payment/messaging provider, Redis, DB, Temporal) declares an explicit timeout and retry policy at the call site — no implicit defaults.
- Retries are bounded, backoff-based (jittered exponential), and idempotency-safe: financial actions derive idempotency keys as `tenant_id + recovery_case_id + action_type + attempt_number` (spec 01 §21).
- Provider calls are wrapped by adapters (`packages/integrations`) so policy applies uniformly.

## 9. Transactions & state

- Every DB write that changes business state runs inside an explicit transaction boundary owned by a service function (not a controller, not an activity helper).
- All state machines (case status, action status, workflow states) are defined once in `packages/domain`. DB updates use **guarded conditional writes** (`UPDATE … WHERE status = <expected>`) — see s-06; unguarded writes fail review.
- PostgreSQL constraints enforce invariants first (unique idempotency keys, non-negative money, enum statuses).

## 10. AI behavior (governing principles)

Inherited by every step that touches LLM output:

- The LLM may only: diagnose cause, rank interventions from the closed Action Catalog (spec 02 §6), draft template-parameter content within allowlists, and set stop conditions.
- The LLM may NEVER: move money, trigger retries itself, send messages itself, alter discounts beyond configured caps, contact opted-out customers, or choose actions outside the catalog.
- Every LLM output passes: JSON-Schema structural validation → semantic validation → policy evaluation before any execution path sees it. No tool-calling (ADR-008).

## 11. Observability & correlation

- Propagation format: W3C Trace Context headers (`traceparent`) plus internal `x-correlation-id` (echoed on responses). Inbound webhooks generate a correlation ID if none arrives.
- Five core trace keys appear on spans/logs end-to-end (spec 01 §20): `event_id`, `case_id`, `workflow_id`, `decision_id`, `action_id`.
- Standard span attributes convention (ADR-014, `@repo/observability`):
  `recovery.event_id`, `recovery.case_id`, `recovery.workflow_id`, `recovery.decision_id`, `recovery.action_id`, `tenant.id`, `llm.model`, `provider.name`, `provider.operation`.
- Metrics baseline: HTTP latency, workflow latency, LLM latency/tokens, provider latency/failures, policy rejection rate, recovery success rate (spec 01 §20), exposed at `GET /metrics`.

## 12. Security & secrets

- `.env` is gitignored; real secrets exist only in environment/secret manager — never in the repo, never in logs.
- `sk_*`, `whsec_*`, API keys, and session identifiers are redacted from logs (deny-by-default allowlist).
- Provider credentials are reachable ONLY from `packages/integrations`; no other package imports provider SDKs or reads their env vars.
- Webhook signature verification precedes any processing; tenant context is mandatory on every request (`TENANT_CONTEXT_MISSING` otherwise).

## 13. Testing

- Vitest is the primary runner (ADR-013); root workspace config discovers projects across `apps/*`, `services/*`, `packages/*`. `bun test` allowed only for pure domain units.
- Shared fixtures/factories/helpers go in `packages/testing`; tests never construct financial rows by hand when a factory exists.
- Layer mapping (spec 01 §23): unit (domain/risk/policy/schema/state transitions) · integration (webhook→DB→bus→AI→policy→workflow→adapter→outcome) · workflow (Temporal test environment) · E2E (composed stack, s-32).
- Failure injection switches (spec 03 §9) are honored by adapters/tests so resilience claims are executable.

## 14. Git & delivery

- Branch naming: `feat/<step-id>-<slug>` (e.g., `feat/s-07-fastify-skeleton`); fixes: `fix/<slug>`.
- Commit messages reference the roadmap step id with prefix, e.g. `s-07: add fastify app factory and graceful shutdown`.
- One roadmap step per PR when practical; PR description links the step file's Definition of Done.
- `specs/` files are never modified by implementation steps; progress is tracked only in `specs/steps/progress.md`.

## 15. Authentication, RBAC & Tenant Context (ADR-012 & Step 09)

All routes requiring caller authorization declare decorators and pre-handlers:

- **Request Auth Decorator**: Fastify decorates `request.auth` in the global `onRequest` hook:
  ```ts
  request.auth = {
    kind: "session" | "api_key",
    userId?: string,
    tenantId: string,
    role: "ADMIN" | "FINANCE" | "OPERATIONS" | "SUPPORT" | "VIEWER",
    scopes?: string[],
  };
  ```
  - Note (patch-02 G-09-1): `"webhook"` was removed from the union (was dead — never assigned). Webhook callers are verified by provider HMAC guards in s-10 (`modules/webhooks/*`) and never receive a `request.auth` principal.
- **Pre-handler Guards**:
  - `fastify.requireAuth`: Rejects unauthenticated requests with `401 UNAUTHENTICATED`.
  - `fastify.requireRole(...roles)`: Rejects callers without required roles with `403 FORBIDDEN`.
- **Mandatory Tenant Context Guard**:
  - Handlers and services resolve tenant scope strictly through `fastify.getTenantScope(request)` (or `getTenantScope(request)` helper).
  - Returns `{ tenantId: string }`. If missing or invalid, throws `TenantContextMissingError` (`TENANT_CONTEXT_MISSING`, status `400`). Cross-tenant access is impossible because tenantId is never read from unverified request parameters.
- **Sessions & API Keys**:
  - Dashboard users: `rr_session` cookie (httpOnly, sameSite=Lax, Secure in prod, 12h sliding renewal, argon2id password verification, 5 attempts/min lockout backoff).
  - Machine clients: `Authorization: Bearer rrk_<tenant>_<random>`, SHA-256 lookup, async `last_used_at` touch.
- **Permission Matrix** (spec 01 §22, s-09 matrix in `packages/domain/src/permissions/matrix.ts`):
  - Note (s-09 audit G-09-1, non-breaking): the implemented matrix is a deliberate superset of the s-09 spec table — it adds `STOP_CASE` (FINANCE + ADMIN only). Access semantics for all spec-listed actions are unchanged; `STOP_CASE` is denied for VIEWER/SUPPORT/OPERATIONS. See the matrix file header and `matrix.test.ts` (exhaustive role × action coverage including `STOP_CASE`).
  - Note (patch-02 G-09-2): `requireScope("admin:manage")` MUST always be paired with `requireRole("ADMIN")` (role guard first). The `requireScope` session fallback admits ADMIN or OPERATIONS for any scope by design (operational scopes like `events:write`/`ai:decide`), so the role guard is what enforces admin-only. Webhook callers never receive `request.auth` (HMAC-verified in s-10).
