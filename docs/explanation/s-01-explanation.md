# s-01 — Architecture Baseline & Implementation Contract: Implementation Explanation

This document explains, in complete depth, everything that was done to implement `specs/steps/s-01.md`. It is written so that a developer (or future agent) who was not present during implementation can understand every file, every decision, and every deliberate non-change. Step s-01 builds **no product features** — it converts the four specification documents in `specs/` into a single, unambiguous implementation contract (decisions, layout, conventions, traceability) that steps s-02…s-35 reference instead of re-debating.

This file also closes the s-01 audit gap: per `AGENTS.md`, every step mandates a comprehensive explanation file following the structure of `docs/explanation/s-2-explanation.md` and `docs/explanation/s-3-explanation.md`. No test numbers are invented here; verification evidence cites exactly what `specs/steps/progress.md` records for 2026-08-25.

---

## Table of contents

1. [What the step required](#1-what-the-step-required)
2. [Decision records (`docs/adr/ADR-001..013`)](#2-decision-records-docsadradr-001013)
3. [System map (`docs/ARCHITECTURE.md`)](#3-system-map-docsarchitecturemd)
4. [Engineering rules (`docs/CONVENTIONS.md`)](#4-engineering-rules-docsconventionsmd)
5. [Requirements traceability (`docs/TRACEABILITY.md`)](#5-requirements-traceability-docstraceabilitymd)
6. [Naming mapping (spec ↔ repo)](#6-naming-mapping-spec--repo)
7. [Layout gap review (repo vs target)](#7-layout-gap-review-repo-vs-target)
8. [Recommended architectural addition (test scaffolding)](#8-recommended-architectural-addition-test-scaffolding)
9. [Verification evidence (Definition of Done)](#9-verification-evidence-definition-of-done)
10. [Deviations and judgment calls](#10-deviations-and-judgment-calls)
11. [Explanation filename convention note](#11-explanation-filename-convention-note)

---

## 1. What the step required

Step s-01 has one objective: resolve every "which exact technology / which convention" question **before any code is written**, so later steps (and coding agents) execute s-02…s-35 without rediscovering context. The four specs supply the *what* and *why* (product vision in `00`, build sequence in `01`, service boundaries in `02`, MVP scope in `03`); s-01 produces the *how-we-build* contract.

The Definition of Done checklist (from the step file):

- `docs/adr/ADR-001..013` exist and are accepted (no TBDs)
- `docs/ARCHITECTURE.md` diagram matches spec 01 §0 and maps components to repo paths
- `docs/CONVENTIONS.md` covers errors, logging, money, time, timeouts, transactions, branching
- `docs/TRACEABILITY.md` covers all rows of spec 03 §1 matrix and spec 01 §29 DoD items
- Naming mapping (backend↔api, frontend↔web) recorded
- Repository reviewed against layout; gaps assigned to concrete steps
- No application behavior changed; `bun run check-types` still passes at root

Requirement coverage carried into the contract: the architectural contract (`AI = recommendation + interpretation; Policy = permission; Temporal = execution + durability; PostgreSQL = source of truth; Event bus = asynchronous propagation; Adapters = provider-specific execution; Dashboard = observation`, spec 02 §1), the core loop (Detection → Decision → Policy → Execution → Outcome → Learning, spec 00 §1), the bounded-autonomy principle (AI recommends; deterministic infrastructure decides and executes, spec 00 §1/§8), and the MVP scope boundaries including "What NOT to build initially" (spec 01 §30, spec 03 §1). AI-behavior principles, secret-handling rules, and the correlation-ID propagation format were recorded once here and inherited by every later step.

Everything below maps to those items.

---

## 2. Decision records (`docs/adr/ADR-001..013`)

**Directory:** `docs/adr/`

Thirteen numbered, accepted records with no TBDs — one per binding decision in the step file's table. Each ADR is settled and binding; later changes require a superseding ADR, never a silent re-litigation (index rule in `docs/adr/README.md`).

| # | Decision | Value recorded | Rationale source |
|---|---|---|---|
| ADR-001 | Runtime | Bun ≥ 1.4 for API + worker; Node-compatible code style (no Bun-only APIs outside entrypoints) | Repo is Bun-locked via `bun.lock` and `devEngines`; Next.js runs on its own runtime |
| ADR-002 | HTTP framework | Fastify 5 on Bun (replace raw `Bun.serve` in `apps/backend/src/index.ts`) | Spec 01 §3; plugins give schema validation, hooks, lifecycle |
| ADR-003 | Database | PostgreSQL (Neon/Lakebase-compatible) + Drizzle ORM, pooled client via `postgres.js` with `prepare:false` | Spec 01 §3; `packages/db` already wired this way |
| ADR-004 | Migrations | Drizzle Kit SQL migrations via `packages/db/src/migrate.ts` using `DIRECT_URL`, advisory-locked, forward-only | Existing migrate.ts pattern; transaction-pooler safe |
| ADR-005 | Workflow engine | Temporal (self-hosted via Docker locally), namespace `revenue-recovery`, task queue `recovery-main` | Spec 01 §3, spec 02 §2 |
| ADR-006 | Event streaming | Redpanda topic `revenue-events.v1` behind an `EventBus` interface with in-process fallback selected by env | Spec 01 §3 ("keep Kafka/Redpanda optional in the earliest local prototype") |
| ADR-007 | Cache/locks/rate-limit | Redis | Spec 01 §3 |
| ADR-008 | LLM access | OpenAI-compatible chat-completions client (configurable base URL), structured outputs enforced by JSON Schema, model from `AI_MODEL`, no tool-calling, no arbitrary tools | Spec 01 §10, spec 02 §6 action allowlist |
| ADR-009 | Money type | Integer minor units (paise/cents) in `bigint` columns; ISO-4217 `currency CHAR(3)`; never floats | Financial correctness |
| ADR-010 | IDs | UUIDv4 via `gen_random_uuid()` for business PKs; bigserial for append-only logs; human case number `RC-{per-tenant sequence}` for display | Readability + join performance |
| ADR-011 | Time | Store UTC `timestamptz`; expose ISO-8601; business-day math per tenant timezone only where required | Prevents DST bugs |
| ADR-012 | AuthN/Z | Dashboard email+password sessions (httpOnly cookie) server-side; machine APIs tenant-scoped bearer keys; webhooks provider-signature verified; RBAC exactly ADMIN, FINANCE, OPERATIONS, SUPPORT, VIEWER | Spec 01 §22, spec 03 §11 |
| ADR-013 | Test runner | Vitest primary (Temporal SDK testing compatibility); `bun test` allowed for pure domain units | Reliability of Temporal TestEnvironment under Bun unproven |

ADR read triggers are codified in `AGENTS.md` (money → ADR-009, tables/ids → ADR-010, time → ADR-011, routes/plugins → ADR-002, DB/migrations → ADR-003/004, events → ADR-006, Redis → ADR-007, LLM → ADR-008, auth → ADR-012, tests → ADR-013), so later steps consult decisions instead of re-deciding.

Note on later ADRs: ADR-014 (observability stack, s-08), ADR-015 (RLS deferred, s-30), and ADR-016 (dashboard pushgateway, s-34) were added by their owning steps. They extend — never contradict — the s-01 baseline.

---

## 3. System map (`docs/ARCHITECTURE.md`)

Single-page map annotated with concrete repo paths and owning steps:

- **§1 Naming mapping** — records the canonical spec↔repo correspondence (see §6 below); spec names never rename repo folders.
- **§2 System diagram** — adapted from spec 01 §0: provider webhooks → Fastify Event Gateway (`apps/backend`) → EventBus (Redpanda `revenue-events.v1` or in-process fallback, ADR-006) → Risk Engine + Context Service → AI Decision Service → Policy Engine → Temporal durable workflows (`services/worker`, ADR-005) → payment/messaging/human-escalation adapters → PostgreSQL source of truth (ADR-003/004) → Next.js dashboard (observation only). Cross-cutting packages (`config` s-02, `domain` s-03, `observability` s-08) and infra (`docker`/`temporal` s-02, `grafana` s-08/s-34) are called out explicitly.
- **§3 Component responsibility table** — copied from spec 02 §2 with repo locations, implementing steps, and a "Does NOT" column per component (the enforceable form of the spec 02 §1 architectural contract, restated verbatim at the section's close).
- **§4 Target repository layout** — the full `apps/` + `services/worker/` + `packages/` + `infra/` + `docs/` tree from the step file, used as the creation checklist for all later steps.
- **§5 Layout gap review** — every delta between the existing scaffold and the target tree assigned to a concrete owning step (see §7 below).
- **§6 ERD appendix** — added later by s-04/s-05 (schema owners); not part of the s-01 baseline and claimed by no s-01 DoD item.

---

## 4. Engineering rules (`docs/CONVENTIONS.md`)

Binding rules inherited by every later step (changes require a new ADR or an explicit roadmap-logged edit):

- **§1 Module layout** — backend suffix pattern (`*.controller.ts` routes/schemas, `*.service.ts` business logic + transaction boundaries, `*.types.ts`); cross-cutting Fastify concerns in `apps/backend/src/plugins/`; all SQL in `packages/db/src/repositories`; `packages/domain` owns entities/enums/state machines/envelope/catalog with no framework imports; `packages/config` is the only place `process.env` is read; provider credentials reachable only from `packages/integrations`; worker splits `workflows/` (deterministic, no network) vs `activities/` (side effects).
- **§2 Naming** — kebab-case files, camelCase vars/functions, PascalCase types, SCREAMING_SNAKE constants/statuses/actions/error codes, snake_case DB identifiers, dot-separated lowercase event types, `@repo/*` package scope.
- **§3 Money (ADR-009)** — integer minor units everywhere (DB, TS, JSON); presentation formatting only at the edge via `@repo/domain`.
- **§4 Time (ADR-011)** — UTC `timestamptz` storage, ISO-8601 API exposure, tenant-timezone day math isolated in utilities, relative workflow durations.
- **§5 Identifiers (ADR-010)** — UUIDv4 business PKs, bigserial log ordering, `RC-{seq}` display-only.
- **§6 Errors** — domain error classes with stable machine codes; canonical `{ error: { code, message, details } }` envelope (the exact JSON shape from the step file's API Contracts section); central Fastify handler maps to status; `INTERNAL_ERROR` 500 default; `VALIDATION_FAILED` with field details.
- **§7 Logging** — structured JSON via pino (through `packages/observability` from s-08); mandatory `correlation_id`/`tenant_id`/`case_id` when present; deny-by-default secret/PII redaction; four level semantics.
- **§8 Timeouts & retries** — explicit timeout + bounded jittered-exponential retry at every external call site; idempotency keys as `tenant_id + recovery_case_id + action_type + attempt_number` (spec 01 §21); adapters in `packages/integrations`.
- **§9 Transactions & state** — explicit service-owned transaction boundaries; all state machines defined once in `packages/domain` with guarded conditional DB writes (`UPDATE … WHERE status = <expected>`, see s-06); Postgres constraints enforce invariants first.
- **§10 AI behavior** — the governing principles recorded once (LLM may only diagnose, rank closed-catalog interventions, draft allowlisted template content, set stop conditions; may never move money, self-trigger retries/messages, exceed discount caps, contact opted-out customers, or leave the catalog; every output passes JSON-Schema → semantic → policy validation; no tool-calling per ADR-008).
- **§11 Observability & correlation** — W3C `traceparent` + `x-correlation-id` propagation; the five core trace keys (`event_id`, `case_id`, `workflow_id`, `decision_id`, `action_id`, spec 01 §20); standard span attributes (ADR-014); metrics baseline with `GET /metrics`.
- **§12 Security & secrets** — `.env` gitignored, real secrets only in environment/secret manager, log redaction deny-by-default, provider credentials confined to `packages/integrations`, webhook verification before processing, mandatory tenant context (`TENANT_CONTEXT_MISSING`).
- **§13 Testing** — Vitest primary (ADR-013), shared fixtures in `packages/testing`, four-layer mapping (unit · integration · workflow · E2E per spec 01 §23), failure-injection switches honored by adapters/tests.
- **§14 Git & delivery** — `feat/<step-id>-<slug>` branches, `s-XX:` commit prefixes, one step per PR, `specs/` never modified by implementation steps.
- **§15 Auth/RBAC/tenant context (ADR-012, s-09)** — `request.auth` decorator shape, `requireAuth`/`requireRole` guards, `getTenantScope` mandatory-context rule, session cookie + API-key lifecycle details; added by the owning step, listed here for completeness.

Security considerations from the step file (secret-handling rules, `.env` gitignored, `sk_*`/`whsec_*` never logged, provider credentials only from `packages/integrations`) live in §12; the observability decision (W3C Trace Context + `x-correlation-id`, five core trace keys) lives in §11; the state-machine ownership rule (all machines in `packages/domain`, guarded conditional writes) lives in §9.

---

## 5. Requirements traceability (`docs/TRACEABILITY.md`)

Initial rows sourced exactly as the step file prescribes:

- Spec 03 §1 feature matrix — each row → implementing step.
- Spec 03 §8 acceptance tests → s-32.
- Spec 03 §9 failure-injection switches → s-29 (switches) and s-31 (tests).
- Spec 01 §29 definition-of-done list (18 items) → mapped across s-10…s-32.
- Spec 00 §9 metrics → s-26/s-27.

Every later step appends/confirms rows in its "Requirement Coverage" work; the file's header rules (append-only, confirm-on-DONE) come from this step.

---

## 6. Naming mapping (spec ↔ repo)

Recorded in `ARCHITECTURE.md` §1 and kept as canonical — **do not rename**:

| Spec name | Repo path (canonical) | Role |
|---|---|---|
| `apps/api` | `apps/backend` | Fastify event gateway + internal REST APIs |
| `apps/web` | `apps/frontend` | Next.js dashboard |
| `services/ai-decision` | `apps/backend/src/modules/ai` | Collapsed into backend (spec 01 §2 allows collapsing for MVP) |
| `services/risk-engine` | `apps/backend/src/modules/risk` + consumer wiring | Collapsed into backend |
| `services/worker` | `services/worker` | Temporal worker |

Shared code always lives in `packages/*` regardless of importer.

---

## 7. Layout gap review (repo vs target)

Reviewed at s-01 (`ARCHITECTURE.md` §5). Every gap has an owning step; nothing unassigned:

| Gap | State at review | Owner |
|---|---|---|
| `apps/backend/src/index.ts` raw `Bun.serve` stub | exists, replace with `app.ts` + `server.ts` | s-07 |
| `apps/backend/src/modules/*`, `plugins/*` | missing | s-07…s-10, s-13, s-14, s-16, s-27, s-29 |
| `services/worker/` | missing | s-20 |
| `packages/domain/` | missing | s-03 |
| `packages/config/` | missing | s-02 |
| `packages/observability/` | missing | s-08 |
| `packages/policy/` | missing | s-16 |
| `packages/integrations/` | missing | s-18, s-19 |
| `packages/db/src/repositories/` | missing (schema empty) | s-04…s-06 |
| `packages/testing/` | skeleton created (this step) | filled s-06 onward |
| `infra/docker/`, `infra/temporal/` | missing | s-02 |
| `infra/grafana/` | missing | s-08 (provisioning), s-34 (dashboards/runbooks) |
| `docs/` ADRs, conventions, traceability | created (this step) | updated by each later step |

---

## 8. Recommended architectural addition (test scaffolding)

Per the step file's explicit recommendation, the **Vitest workspace config + `packages/testing` skeleton** were created now (empty scaffolding only) so every later step adds tests into an existing structure instead of inventing one mid-stream — required because spec 01 §23 demands unit/integration/workflow/E2E layers from Week 1 onward. No runtime tests were added in s-01; the skeleton is structure, not coverage.

---

## 9. Verification evidence (Definition of Done)

Evidence is cited exactly as recorded in `specs/steps/progress.md` (completion-log entry dated 2026-08-25). No test counts are invented — s-01 added no runtime tests.

| DoD item | Evidence |
|---|---|
| ADR-001..013 accepted, no TBDs | 13 records in `docs/adr/` (progress log 2026-08-25) |
| ARCHITECTURE.md matches spec 01 §0, maps components to repo paths | Diagram + responsibility table + naming mapping + target layout + gap review, per §3/§6/§7 above |
| CONVENTIONS.md covers errors, logging, money, time, timeouts, transactions, branching | §6–§9, §7, §14 per §4 above |
| TRACEABILITY.md covers spec 03 §1 matrix + spec 01 §29 DoD | Initial rows per §5 above |
| Naming mapping recorded | ARCHITECTURE.md §1 (§6 above); no folders renamed |
| Gaps assigned to concrete steps | Gap-review table (§7 above); nothing unassigned |
| No behavior changed; `bun run check-types` passes | Progress log 2026-08-25: `bun run check-types` green (4/4 pkgs); `bun run test` exits clean (no runtime tests yet); `bun run check-docs` green (19 links OK) |

---

## 10. Deviations and judgment calls

Small, deliberate, and traceable:

1. **Test scaffolding created despite "no code" language** — the step file says "no application source code is modified" while simultaneously recommending the Vitest workspace + `packages/testing` skeleton. The recommendation (spec 01 §23 Week-1 test layers) governs: scaffolding only, zero runtime tests, zero behavior change.
2. **Docs-lint check** — the step file suggests (optional) a markdown link checker; it was adopted (`bun run check-docs`, 19 links OK per the progress log), which is why later steps can safely cross-link docs.
3. **ADR index discipline** — `docs/adr/README.md` declares decisions settled and non-relitigable (supersede, don't rewrite), giving later steps the "reference instead of re-debate" behavior the step's *Why* section demands.
4. **Nothing else touched** — no spec modifications, no application behavior change, no drive-by refactors; the existing Turborepo scaffold (`apps/backend` stub, `apps/frontend` shell, empty Drizzle schema) was left exactly as found for its owning steps.

---

## 11. Explanation filename convention note

Earlier explanations landed as `docs/explanation/s-2-explanation.md` and `docs/explanation/s-3-explanation.md` (single-digit, no zero-pad), while step files use zero-padded ids (`s-02.md`, `s-03.md`). This file uses the zero-padded form (`s-01-explanation.md`) to match its step id. The older `s-2`/`s-3` filenames are **intentionally left as-is**: renaming them without updating every inbound link would break `bun run check-docs`. If a future step normalizes the names, it must rename the files *and* fix all links in the same change, then re-run `check-docs`.
