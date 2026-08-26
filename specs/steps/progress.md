# Implementation Progress Tracker

This file tracks execution status of the roadmap in this folder. **Update it every time a step is completed** so any developer or coding agent can resume exactly where work stopped.

- Roadmap overview: [`README.md`](./README.md)
- Each step's full requirements and its own Definition of Done checklist live in its `s-X.md` — this file only tracks *status*, it does not replace the step files.

---

## How to use this file

1. When starting a step: set its Status to `IN PROGRESS` and fill in "Started On".
2. When finishing a step: verify **every box** in that step's `## Definition of Done` first, then set Status to `DONE`, fill in "Completed On", and add one row to the Completion Log.
3. If blocked: set Status to `BLOCKED` and describe the blocker in Notes plus the Open Issues section.
4. Always update the "Last updated" header and "Current position" line.
5. Never delete history — append. Corrections are new log entries, not edits of old ones.

**Status vocabulary:** `NOT STARTED` · `IN PROGRESS` · `DONE` · `BLOCKED` · `SKIPPED` (only with an entry in Deferred Items explaining why and where the requirement moved).

---

## Current position

```text
Last updated : 2026-08-27   (update on every change)
Current step : s-08 Observability Foundation
Next up      : s-08 — not started
Overall      : 7 / 35 steps complete
```

---

## Summary by phase

| Phase | Steps | Done | Status |
|---|---|---|---|
| Foundation (architecture, infra, domain) | s-01–s-03 | 3 / 3 | DONE |
| Data layer (schemas, repositories) | s-04–s-06 | 3 / 3 | DONE |
| Platform (API skeleton, observability, auth) | s-07–s-09 | 1 / 3 | IN PROGRESS |
| Ingestion (gateway, bus, risk, context) | s-10–s-13 | 0 / 4 | NOT STARTED |
| Intelligence (AI decision, governance, policy) | s-14–s-16 | 0 / 3 | NOT STARTED |
| Execution (orchestration, adapters, Temporal, approvals) | s-17–s-21 | 0 / 5 | NOT STARTED |
| Workflows (payment, checkout, invoice) | s-22–s-24 | 0 / 3 | NOT STARTED |
| Product (audit, outcomes, analytics, dashboard, demo) | s-25–s-29 | 0 / 5 | NOT STARTED |
| Verification & ship (security, chaos, e2e, deploy, ops, release) | s-30–s-35 | 0 / 6 | NOT STARTED |

---

## Step status

| Step | Title | Status | Started On | Completed On | Notes / Evidence |
|---|---|---|---|---|---|
| s-01 | Architecture Baseline & Implementation Contract | DONE | 2026-08-25 | 2026-08-25 | `docs/adr/ADR-001..013` accepted; ARCHITECTURE.md / CONVENTIONS.md / TRACEABILITY.md created; naming mapping recorded; layout gap review assigned to steps; `packages/testing` skeleton + root vitest workspace config added; docs link check green |
| s-02 | Local Infrastructure & Configuration Platform | DONE | 2026-08-25 | 2026-08-25 | `infra/docker/docker-compose.yml` (7 services incl. Next.js frontend, healthchecks green via `up -d --build --wait`), `infra/temporal/dynamicconfig.yaml`, namespace `revenue-recovery` auto-created (tctl verified), Temporal UI :8080, Redpanda console :8081, frontend :3000 reachable; `packages/config` zod-validated presets (`apiConfig`/`workerConfig`/`webConfig`) + 13 unit tests; `.env.example` extended; root `infra:up`/`infra:down`; `db:migrate` green vs composed Postgres; backend stub reads `@repo/config` |
| s-03 | Shared Domain Package (`@repo/domain`) | DONE | 2026-08-27 | 2026-08-27 | `packages/domain` pure TS + zod only: branded ids, money helpers (integer minor units, truncation parse/format), 12 enum modules (case/risk/payment/checkout/invoice/action/event/channel/actor/stop-condition/case-event), domain event envelope (strict zod incl. traceparent), recovery-case state machine (transition table + `assertTransition` + `IllegalTransitionError` + terminal set), closed action catalog (zod params per action, unknown-type rejection at runtime via `tryValidateCatalogAction` and schema level, `AI_DECIDABLE_ACTIONS` per surface), policy-limit constants, all 16 entity types; 202 unit tests (exhaustive 10×10 transition matrix, envelope accept/reject, catalog validation incl. incentive cap vs `MAX_AUTO_DISCOUNT_MINOR`, spec-parity snapshots) |
| s-04 | Database Schema: Financial Core Entities | DONE | 2026-08-27 | 2026-08-27 | Drizzle schema for 11 tables (tenants, users, api_keys, customers, payments, payment_attempts, subscriptions, checkouts, checkout_events, invoices, invoice_events); citext extension; pgEnum mirroring @repo/domain; forward-only migration 0000 generated & applied; 22 tests (11 enum parity + 11 live Postgres DB constraints/indexes); DoD green |
| s-05 | Database Schema: Recovery Domain Entities | DONE | 2026-08-27 | 2026-08-27 | Drizzle schema for 18 recovery tables across 13 schema files (events, risks, cases, decisions, actions, workflows, workflow_events, messages, message_delivery_events, customer_responses, promises_to_pay, human_tasks, policy_rules, policy_versions, policy_evaluations, audit_logs, case_events, recovery_outcomes, recovery_cost_entries, idempotency_keys); 5 anti-duplication anchors proven; generated column net_recovered verified; pgEnum parity tested; migration 0001 generated & applied; ERD diagram added to ARCHITECTURE.md; 269 tests passing across workspace |
| s-06 | Migration Pipeline & Repository Layer | DONE | 2026-08-27 | 2026-08-27 | Hardened migration runner with advisory lock (724193), transient retry, and `db:migrate:check` CI script; implemented 23 aggregate repositories with strict tenant-scoping by signature, withTransaction context wrapper, guarded state transitions, monotonic per-tenant case numbering (`pg_advisory_xact_lock`), compile-time/runtime append-only guarantees, packages/db/README.md transaction boundary table; 287 tests passing across workspace |
| s-07 | Backend Application Skeleton (Fastify) | DONE | 2026-08-27 | 2026-08-27 | Fastify 5 app factory (`buildApp`), server entrypoint with signal-aware graceful shutdown (20s in-flight drain), request context + W3C traceparent correlation, structured Pino logging with secret redaction, canonical error envelope across 400/404/413/422/429/500, Redis rate limiting with graceful fallback, CORS allowlist, db/repos decoration, route registry, /health, /api/health, /ready (5s cache), /version; 314 tests passing across workspace |
| s-08 | Observability Foundation | NOT STARTED | | | |
| s-09 | Authentication, Authorization & Tenant Context | NOT STARTED | | | |
| s-10 | Event Gateway & Webhook Ingestion | NOT STARTED | | | |
| s-11 | Internal Event Bus & Replay | NOT STARTED | | | |
| s-12 | Risk Engine v1 | NOT STARTED | | | |
| s-13 | Customer Context Service | NOT STARTED | | | |
| s-14 | AI Decision Service: Core Decision Path | NOT STARTED | | | |
| s-15 | AI Governance & Evaluation Harness | NOT STARTED | | | |
| s-16 | Policy Engine | NOT STARTED | | | |
| s-17 | Recovery Case Orchestration Pipeline | NOT STARTED | | | |
| s-18 | Payment Provider Adapters | NOT STARTED | | | |
| s-19 | Messaging Adapters & Delivery Ledger | NOT STARTED | | | |
| s-20 | Temporal Foundation (Worker Service) | NOT STARTED | | | |
| s-21 | Human Escalation & Approvals | NOT STARTED | | | |
| s-22 | Workflow A: Failed Payment Recovery | NOT STARTED | | | |
| s-23 | Workflow B: Checkout Abandonment | NOT STARTED | | | |
| s-24 | Workflow C: Overdue Invoice & Promise-to-Pay | NOT STARTED | | | |
| s-25 | Audit Trail & Case Timeline Completion | NOT STARTED | | | |
| s-26 | Outcomes, Attribution & Cost Model | NOT STARTED | | | |
| s-27 | Analytics Service & APIs | NOT STARTED | | | |
| s-28 | Dashboard UI | NOT STARTED | | | |
| s-29 | Demo Mode, Simulation Endpoints & Seed Data | NOT STARTED | | | |
| s-30 | Security Hardening & Compliance Verification | NOT STARTED | | | |
| s-31 | Resilience, Chaos & Concurrency Testing | NOT STARTED | | | |
| s-32 | End-to-End Acceptance Tests | NOT STARTED | | | |
| s-33 | CI/CD & Deployment | NOT STARTED | | | |
| s-34 | Monitoring, Alerting & Operations Runbooks | NOT STARTED | | | |
| s-35 | Final Hardening, Demo Readiness & Release | NOT STARTED | | | |

---

## Milestone gates

Tick when the gate becomes verifiable (these are the moments the system changes shape):

- [x] **G1 — Data layer standing** (after s-06): migrations apply from empty DB; repositories race-tested
- [ ] **G2 — Events flow** (after s-11): signed webhook → dedupe → bus → consumer, proven under both bus drivers
- [ ] **G3 — Loop closed headlessly** (after s-17): event produces an IN_PROGRESS case via risk→AI→policy without human touch
- [ ] **G4 — Durable execution live** (after s-24): all three workflows pass their harness suites incl. approval paths
- [ ] **G5 — Demoable product** (after s-29): fresh clone → compose → seed → dashboard populated → simulator drives real recovery end-to-end
- [ ] **G6 — Release gate green** (after s-32): full E2E journey + acceptance blocks pass against composed stack
- [ ] **G7 — Shipped** (after s-35): v0.1.0 tagged, deployed, smoke green, demo rehearsed

---

## Open issues & blockers

Append entries here while any step is `BLOCKED`; remove only when resolved (note resolution in the log).

```text
(none)
```

---

## Deferred items & deviations

Record anything intentionally skipped or implemented differently from the step file, with rationale and where the responsibility moved. Empty list = implementation matches the roadmap exactly.

| Date | Step | Item | Rationale | Follow-up owner/reference |
|---|---|---|---|---|

---

## Completion log (append-only)

One line per completed step or notable event. Format: `- YYYY-MM-DD | s-XX | short outcome | verification run (e.g., 'bun run test:e2e green', commit sha)`.

```text
2026-08-25 | s-01 | Architecture baseline complete: 13 ADRs, ARCHITECTURE/CONVENTIONS/TRACEABILITY docs, naming mapping, layout gap review, packages/testing skeleton + vitest workspace config | bun run check-types green (4/4 pkgs); bun run test exits clean (no runtime tests yet); bun run check-docs green (19 links OK)
2026-08-25 | s-02 | Local infra + config platform: compose stack (7 services incl. frontend, all healthy), temporal dynamicconfig + namespace auto-create, @repo/config (zod, fail-fast, frozen), env hygiene (.gitignore .env* except example), infra:up/down scripts, empty-migration scaffold for db:migrate | docker compose up -d --build --wait all green; UI :8080 / console :8081 / frontend :3000 / tctl namespace OK; bun run db:migrate green; bun run check-types 5/5; bun run test 13/13; bun run lint green; check-docs 19 links OK
2026-08-27 | s-03 | Shared domain package complete: packages/domain (`@repo/domain`) with ids/money/enums/envelope/state-machine/action-catalog/policy-limits/entities per spec 01 §1/§6/§12/§17, spec 02 §4–§6, spec 03 §6; zero runtime deps except zod; `@repo/domain` workspace dep declared in `@repo/db` + backend (cross-workspace import verified); DoD checklist all satisfied | bun run check-types green (6/6 pkgs); bun run test green (202 tests incl. exhaustive transition matrix, envelope accept/reject, catalog validation, enum↔spec parity); bun run lint green
2026-08-27 | s-04 | Database schema financial core complete: packages/db schema with 11 tables (tenants, users, api_keys, customers, payments, payment_attempts, subscriptions, checkouts, checkout_events, invoices, invoice_events), pgEnum bindings, citext extension, check/unique constraints, spec-mandated indexes, migration 0000 applied cleanly to PostgreSQL | bun run check-types green (6/6 pkgs); bun run test green (225 tests incl. 11 enum parity + 11 live DB constraints/indexes); bun run lint green; check-docs green
2026-08-27 | s-05 | Database schema recovery domain complete: packages/db schema with 18 tables across 13 modules, 5 anti-duplication anchors, generated column net_recovered, migration 0001 applied cleanly & idempotently, ERD added to ARCHITECTURE.md | bun run check-types green (6/6 pkgs); bun run test green (269 tests incl. 36 enum parity + 18 recovery DB constraints/indexes); bun run lint green; check-docs green
2026-08-27 | s-06 | Migration pipeline hardening & repository layer complete: advisory lock (724193) + transient retry in migrate.ts, checkPendingMigrations + db:migrate:check CI script; 23 aggregate repositories with strict tenant-scoping by signature; withTransaction wrapper + Tx type; guarded conditional state transitions; atomic per-tenant sequencing (pg_advisory_xact_lock); append-only compile/runtime enforcement; packages/db/README.md transaction boundary table; milestone G1 unlocked | bun run check-types green (6/6 pkgs); bun run test green (287 tests incl. parallel obligation race x10, action claim race x2, guarded transitions, idempotency lease lifecycle); bun run db:migrate:check green (2/2 applied); bun run lint green; check-docs green (19 links OK)
2026-08-27 | s-07 | Backend Fastify application skeleton complete: Fastify 5 app factory (buildApp), server entrypoint with signal-aware graceful shutdown (20s in-flight drain), request context + W3C traceparent correlation, structured Pino logging with secret redaction, canonical error envelope across 400/404/413/422/429/500, Redis rate limiting with graceful fallback, CORS allowlist, db/repos decoration, route registry, /health, /api/health, /ready (5s cache), /version | bun run check-types green (6/6 pkgs); bun run test green (314 tests across 12 files incl. 27 backend skeleton unit/integration tests); bun run lint green; check-docs green (19 links OK)
```
