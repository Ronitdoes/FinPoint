# Requirements Traceability Matrix

Maps every requirement from the four source specs to the roadmap step(s) (`specs/steps/s-X.md`) that implement it. **Every later step must update this file** in its "Requirement Coverage" work — new rows are appended; existing rows get their step confirmed only when the step is DONE (recorded in `specs/steps/progress.md`).

Sources:

- `specs/00-brainstorm-and-product-vision.md` ("spec 00")
- `specs/01-implementation-0-to-100.md` ("spec 01")
- `specs/02-architecture-and-domain.md` ("spec 02")
- `specs/03-mvp-build-spec.md` ("spec 03")

---

## 1. MVP feature matrix — spec 03 §1

| # | Feature | MVP value | Implementing step(s) | Notes |
|---|---|---|---|---|
| 1 | Payment webhooks | Yes | s-10 | gateway auth, normalize, dedupe, store, publish |
| 2 | Razorpay/Stripe adapter | Yes | s-18 | `packages/integrations/payments`, interfaces per spec 01 §14 |
| 3 | Risk scoring | Rule-based | s-12 | deterministic weighted rules + bands (spec 01 §8) |
| 4 | Customer context | Yes | s-13 | allowlists, size limits, tenant isolation (spec 01 §9) |
| 5 | LLM decisioning | Yes | s-14 | decision path via risk + context input |
| 6 | Structured output | Yes | s-14 | JSON Schema enforced (ADR-008); schema from spec 03 §5 |
| 7 | Policy engine | Yes | s-16 | deterministic hard rules (spec 01 §11) |
| 8 | Temporal | Yes | s-20 | worker foundation; workflows s-22–s-24 |
| 9 | WhatsApp | Yes or mocked adapter | s-19 | mock variant delivered with s-29 demo mode |
| 10 | Email | Yes | s-19 | delivery ledger included |
| 11 | Checkout abandonment | Yes | s-23 | Workflow B |
| 12 | Overdue invoices | Yes | s-24 | Workflow C |
| 13 | Promise-to-pay | Yes | s-24 | within Workflow C scope |
| 14 | Human escalation | Yes | s-21 | signal-based waits (spec 01 §19) |
| 15 | Audit trail | Yes | s-25 | timeline completion + immutability checks |
| 16 | Dashboard | Yes | s-28 | overview, funnel, interventions, case detail (spec 03 §7) |
| 17 | ML scoring | Later | deferred | post-MVP; see §7 below |
| 18 | Voice | Later | deferred | spec 00 §5 expansion idea |
| 19 | Multi-agent | No | excluded | forbidden by spec 01 §30 |
| 20 | Advanced experimentation | Later | deferred | playbook experiments, spec 00 §5 |

Supporting infrastructure for the matrix: local infra + config (s-02), domain package (s-03), financial schema (s-04), recovery schema (s-05), migrations/repositories (s-06), API skeleton (s-07), observability (s-08), authn/authz/tenant context (s-09), event bus + replay (s-11), orchestration pipeline (s-17), outcomes/attribution/cost model (s-26), analytics APIs (s-27).

## 2. Definition of done — spec 01 §29 (18 items)

MVP scenario items mapped across s-10…s-32. "Verified in" names the step whose tests prove the item.

| # | DoD item | Implemented in | Verified in |
|---|---|---|---|
| 1 | Provider sends payment.failed | s-10 | s-10 ✅, s-32 |
| 2 | Event is authenticated | s-10 (signature verification; authn plugins s-09) | s-10 ✅, s-30 |
| 3 | Duplicate event is ignored | s-10 idempotency (+ Redis fast path ADR-007) | s-10 ✅, s-31 concurrency tests, s-32 |
| 4 | Internal event is created | s-11 | s-11 ✅, s-32 |
| 5 | Risk is calculated | s-12 | s-12 ✅ (unit + integration suite), s-32 |
| 6 | Recovery case is created | s-17 | s-17, s-32 |
| 7 | Context is assembled | s-13 | s-13 ✅ (unit + PII sweep + integration suite), s-32 |
| 8 | AI returns schema-valid decision | s-14 (schema enforcement, eval harness s-15) | s-14 ✅ (prompts, structured outputs, repair retry, fallback, 9 integration tests), s-15 |
| 9 | Policy validates decision | s-16 | s-16, s-32 |
| 10 | Temporal workflow starts | s-20 runtime; orchestration trigger s-17 | s-22 workflow harness |
| 11 | Message is sent | s-19 adapters + ledger; used by s-22 | s-22 |
| 12 | Payment retry occurs | s-18 adapter; orchestrated in s-22 | s-22 |
| 13 | Provider returns success | s-18 (mock/live parity) | s-22, s-32 |
| 14 | Outcome is recorded | s-26 | s-26 |
| 15 | Recovered amount is computed | s-26 attribution + cost model | s-26, s-27 |
| 16 | Dashboard reflects it | s-28 reads authoritative outcomes (spec 01 §25) | s-28 |
| 17 | Audit timeline contains every major event | s-25 | s-25, s-32 |
| 18 | System recovers from worker/API restarts | s-20 durable execution design | s-31 chaos/restart tests |

## 3. Acceptance tests — spec 03 §8 → s-32

All blocks are automated as E2E acceptance tests in s-32 (gate G6):

| Spec block | Scenario | s-32 test |
|---|---|---|
| Payment recovery 1 | failed payment → exactly one recovery case | AC-PAY-1 |
| Payment recovery 2 | duplicate webhook → no duplicate case | AC-PAY-2 |
| Payment recovery 3 | retry count = 3 + AI recommends retry → policy rejects | AC-PAY-3 |
| Payment recovery 4 | successful retry → workflow closes, outcome records amount | AC-PAY-4 |
| Checkout 1 | purchase completes → abandonment workflow stops | AC-CO-1 |
| Checkout 2 | abandoned past threshold → recovery case may be created | AC-CO-2 |
| Invoice 1 | high-value overdue invoice + incentive recommendation → human approval required | AC-INV-1 |

## 4. Failure-injection switches — spec 03 §9

| Switch | Switch implemented in | Resilience proven in |
|---|---|---|
| `SIMULATE_PAYMENT_TIMEOUT` | s-29 (demo/simulation endpoints + adapters hooks) | s-31 |
| `SIMULATE_MESSAGE_FAILURE` | s-29 | s-31 |
| `SIMULATE_LLM_FAILURE` | s-29 | s-31 |
| `SIMULATE_DUPLICATE_WEBHOOK` | s-29 | s-31 |

## 5. Key metrics — spec 00 §9 → s-26 / s-27

Modeled/computed in s-26 (outcomes, attribution, cost model); exposed via analytics APIs and dashboard in s-27/s-28.

| Group | Metrics (spec 00 §9) | Computed in | Exposed in |
|---|---|---|---|
| Financial | Revenue at Risk | s-27 (from live cases/risk) | s-27, s-28 |
| Financial | Revenue Recovered · Recovery Rate · Net Recovery · Recovery ROI | s-26 (authoritative outcome rows, spec 01 §25) | s-27, s-28 |
| Financial | Recovery Cost | s-26 cost model (LLM, messaging, processing, discount, human, provider — spec 02 §8) | s-27, s-28 |
| Operational | Active Cases · Average Time to Recovery · Escalation Rate | s-27 | s-27, s-28 |
| Operational | Policy Rejection Rate | emitted at policy evaluation (s-16) | s-27 |
| Operational | Workflow Failure Rate · Provider Failure Rate | otel metrics baseline (s-08) | s-27, s-34 alerts |
| AI | Decision Acceptance Rate · Recommendation-to-Execution Rate · False Intervention Rate | s-15 governance data + s-26 | s-27 |
| AI | AI Cost per Case · AI Cost per ₹ Recovered | s-26 (LLM token/cost capture per ADR-008) | s-27, s-28 |
| AI | Intervention Success Rate | s-26 per-action outcomes | s-27, s-28 intervention table (spec 03 §7) |
| Customer | Opt-out Rate · Complaint Rate · Reply Rate | reply/opt-out capture s-19 (customer responses ledger) | s-27 |
| Customer | Payment Conversion · Promise-to-Pay Completion | payment conversion s-27; PTP completion s-24 events → s-26 | s-27 |

## 6. Cross-cutting requirements

| Requirement | Source | Step(s) |
|---|---|---|
| Architectural contract (AI/Policy/Temporal/PG/bus/adapters/dashboard) | spec 02 §1 | all steps; recorded in ARCHITECTURE.md |
| Core loop Detection→Decision→Policy→Execution→Outcome→Learning | spec 00 §1 | s-10…s-27 chain |
| Bounded autonomy principle | spec 00 §1, §8 | s-14/s-15/s-16 enforcement; CONVENTIONS.md §10 |
| Event envelope standardization | spec 01 §6 | s-03 (envelope in domain) ✅ confirmed; s-11 (bus transport/replay) ✅ |
| Domain vocabulary package `@repo/domain`: entities, enums, canonical state machine + transition table, closed action catalog with zod parameter schemas, policy-limit constants, money helpers (integer minor units), AI-decidable per-surface subsets, case-timeline vocabulary | spec 01 §1, §10, §12, §17; spec 02 §4, §5, §6; spec 03 §5, §6 | s-03 ✅; s-04 ✅ (pgEnum parity confirmed) |
| Idempotency key formula | spec 01 §21 | s-04 ✅ (payment_attempts constraint); s-05 ✅ (actions/messages unique keys); s-18/s-19 adapters; verified s-31 |
| Tenant isolation on business tables | spec 02 §15 | s-04 ✅ (financial core schema FK + indexes); s-05 ✅ (recovery schema FK + indexes); s-06 ✅ (repositories with tenant-first signatures); s-09 request context; s-30 verification |
| Financial core schema, constraints & indexes (tenants, users, api_keys, customers, payments, payment_attempts, subscriptions, checkouts, invoices) | spec 01 §5; spec 02 §1; spec 03 §4 | s-04 ✅ (migration 0000 applied, constraints tested) |
| Recovery domain schema, constraints, partial indexes & anti-duplication anchors (events, revenue_risks, recovery_cases, ai_decisions, recovery_actions, workflows, messages, promises_to_pay, human_tasks, policy_rules, policy_evaluations, audit_logs, case_events, recovery_outcomes, recovery_cost_entries, idempotency_keys) | spec 01 §5, §17, §18, §19, §21, §25; spec 02 §3, §4, §8, §9; spec 03 §4 | s-05 ✅ (migration 0001 applied, 5 anti-duplication anchors tested, generated column verified) |
| Repository layer, explicit transactions & guarded state transitions (23 aggregate repos, withTransaction, guarded updates, advisory-locked migrations, db:migrate:check) | spec 01 §21, §26; spec 02 §15, §16 | s-06 ✅ (repositories implemented, guarded transitions tested, migration lock & CI check green) |
| Backend Fastify application skeleton, plugin pipeline, canonical error envelope across 400/404/413/422/429/500, Redis rate limiting, graceful shutdown, meta endpoints (/health, /ready, /version) | spec 01 §3, §7; spec 02 §13; ADR-002 | s-07 ✅ (Fastify 5 app factory, plugins, routes, lifecycle & 27 unit/integration tests) |
| Security acceptance criteria | spec 03 §11 | s-09/s-10 build; s-30 verifies each line |
| Observability foundation: OpenTelemetry distributed tracing, Prometheus metrics registry (@repo/observability), /metrics endpoint, structured logging with secret redaction, 5 core trace keys propagation | spec 01 §20; spec 02 §1; spec 03 §10; ADR-014 | s-08 ✅ (@repo/observability, Fastify otel plugin, /metrics, compose otel-collector) |
| Authentication, authorization & tenant context (sessions, API keys, RBAC with 5 roles, tenant context guard, login rate-limiting, bootstrap admin seed) | spec 01 §22; spec 03 §11; ADR-012 | s-09 ✅ (user_sessions schema & repo, API keys, Fastify auth/rbac plugins, /auth & /admin routes, seed-admin script, 17 integration tests) |
| Webhook ingestion & event gateway (Stripe & Razorpay HMAC signature verification, pure normalization matrix, financial core transactional upserts, deduplication anchor, EventBus async dispatch, UNMAPPED handling, secret rotation runbook) | spec 01 §7; spec 02 §5, §14; spec 03 §4, §10; ADR-006 | s-10 ✅ (POST /webhooks/stripe, /webhooks/razorpay, normalizers, core upserts, EventBus, rotation runbook, 11 integration tests) |
| Internal Event Bus & Replay (EventBus abstraction with InProcess and Redpanda drivers, consumer framework with retry/backoff/DLQ, poison message routing, POST /events and POST /events/replay endpoints with RBAC & audit trail) | spec 01 §0, §6; spec 02 §13; spec 03 §9; ADR-006 | s-11 ✅ (InProcessEventBus, RedpandaEventBus, consumer.ts, POST /events, POST /events/replay, parity tests, 10 integration tests) |
| Risk Engine v1 (Deterministic Scoring) (weighted rules, 0-100 score, LOW/MEDIUM/HIGH/CRITICAL bands, JSONB factors explainability, event triggers payment.failed/checkout.abandoned/invoice.overdue, upstream resolutions, risk.calculated event, GET /risks & GET /risks/:id) | spec 01 §8; spec 02 §6; spec 03 §6; ADR-006 | s-12 ✅ (revenue_risks state machine, rule catalog, subject scorers, risks.repo.ts, consumer.ts, GET /risks, 10 integration tests) |
| Customer Context Service (single batch queries, field allowlist, PII email/phone masking, deterministic 8KB budget trimming, Redis 30s caching, GET /customers/:id/context endpoint with RBAC & tenant isolation, CustomerContextService.buildForCase) | spec 01 §9; spec 02 §7; spec 03 §6; ADR-007; ADR-008 | s-13 ✅ (modules/customers/context, customer-context.service.ts, allowlist/summarize/trim/pii-sweep unit tests, 8 integration tests) |
| AI Decision Service: Core Decision Path (versioned prompts payment_failure@1/checkout_abandonment@1/invoice_overdue@1, structured JSON schema, OpenAI client with timeout/retries/circuit-breaker, structural + semantic validation, N=1 repair retry, deterministic rule-based fallback, paise token cost tracking, POST /ai/decide & GET /ai/decisions/:id with RBAC & tenant isolation) | spec 01 §10; spec 02 §8; spec 03 §5; ADR-008 | s-14 ✅ (prompts registry, structured LLM service, validation pipeline, AiDecideService, 38 unit + 9 integration tests) |
| AI Governance & Evaluation Harness (pricing table in minor units/paise, multi-provider token normalization, fail-closed unconfigured model guard, confidence hook contract requiresApproval, in-tx recovery_cost_entries writes, GET /ai/decisions & GET /ai/decisions/:id with RBAC inputSnapshot masking, services/eval runner with 30 golden cases across 3 risk surfaces, CI gate gating, docs/PROMPT_EVALUATION.md checklist) | spec 01 §10, §20; spec 02 §8; spec 03 §5; ADR-008, ADR-009 | s-15 ✅ (governance module, pricing/accounting, confidence hooks, eval harness, adversarial test suite, 28 tests) |
| Attribution definition documented | spec 01 §25, spec 02 §9 | s-26 |
| Local infrastructure stack (postgres, redis, temporal, temporal-ui, redpanda, redpanda-console) with healthchecks + named volumes | spec 01 §4 | s-02 |
| `.env.example` + typed/validated config (`@repo/config`, fail-fast, frozen) consumed by apps/services instead of raw `process.env` | spec 01 §3, §4; CONVENTIONS §1, §12 | s-02 |
| Mock-mode & failure-injection env switches declared (`MOCK_PROVIDERS`, `SIMULATE_*`) | spec 03 §2, §9 | s-02 (declaration only; adapters honor them s-18/s-19/s-29) |
| Demo narrative & checklist readiness | spec 01 §27, spec 03 §12 | s-29 seed/demo mode, s-35 rehearsal |

## 7. Explicitly out of scope for the MVP

From spec 01 §30 ("What NOT to build initially") and the Later/No rows of spec 03 §1. These are **not** assigned steps; revisit only after v0.1.0 release gate (G7):

multi-agent architecture · fine-tuned LLM · vector database before retrieval is needed · full ML pipeline · voice agent · Kafka cluster complexity (beyond optional Redpanda compose service) · 20 third-party providers · complex pricing engine · autonomous discount negotiation · fully autonomous collections · ML risk scoring · advanced experimentation/playbooks · CRM/ERP/telephony adapters (interfaces reserved in `packages/integrations`).

---

*Update protocol: when a step completes, tick/confirm its rows here only if the implementation satisfies them, then log the step in `specs/steps/progress.md`. New requirements discovered mid-build are appended as new rows with a source note.*
