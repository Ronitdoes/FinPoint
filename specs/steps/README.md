# AI Revenue Recovery — Implementation Roadmap

This directory contains the complete, dependency-ordered implementation plan for the platform described in [`specs/README.md`](../README.md) and its four source documents (`00` product vision, `01` implementation 0-to-100, `02` architecture/domain, `03` MVP build spec).

Each `s-X.md` is an independently actionable milestone: a developer or coding agent can open it and implement without re-deriving architecture. Steps include objectives, prerequisites, exact requirements, file layouts, data-model changes, API contracts, state transitions, AI guardrails, reliability design (idempotency/retries/queues/concurrency/transactions), tests, and a Definition of Done.

**Progress tracking:** execution status is maintained in [`progress.md`](./progress.md) — update it when starting/completing any step so work can always resume from the recorded position.

## Governing principle (from spec 00 §1)

> **AI decides what should happen; policy + workflow infrastructure decide what is allowed to happen.**

The LLM never moves money, sends messages, or bypasses limits. Every recommendation passes deterministic policy validation before durable (Temporal) execution. This is enforced structurally in s-03/s-14/s-16 and verified in s-30–s-32.

## Core loop being built

```text
Detection → Decision → Policy → Execution → Outcome → Learning
```

## Roadmap at a glance

| Step | Title | Purpose | Depends on | Complexity | Produces |
|------|-------|---------|------------|-----------|----------|
| s-01 | Architecture Baseline & Implementation Contract | ADRs, conventions, repo layout mapping, traceability matrix | — | Low | docs/adr, ARCHITECTURE, CONVENTIONS, TRACEABILITY |
| s-02 | Local Infrastructure & Configuration Platform | Docker Compose stack (PG/Redis/Temporal/Redpanda) + typed env config | s-01 | Medium | infra/docker, packages/config |
| s-03 | Shared Domain Package | Enums, event envelope, case state machine, action catalog, policy constants | s-01 | Medium | packages/domain (+tests) |
| s-04 | DB Schema: Financial Core | tenants/users/api_keys/customers/payments/attempts/subscriptions/checkouts/invoices + spec indexes | s-02,s-03 | High | schema + migration 1 |
| s-05 | DB Schema: Recovery Domain | events, risks, cases, decisions, actions, workflows, messages, PTPs, tasks, policies, audit, outcomes, idempotency store | s-04 | High | schema + migration 2; 5 anti-duplication anchors |
| s-06 | Migration Pipeline & Repository Layer | Advisory-locked migrations, typed repos, guarded transitions, tx boundaries | s-05 | High | repositories/, db:migrate:check |
| s-07 | Backend Skeleton (Fastify) | App factory, plugins, error envelope, health/ready, graceful shutdown | s-02,s-06 | Medium | apps/backend rebuilt on Fastify |
| s-08 | Observability Foundation | OTel tracing, metrics registry (/metrics), correlation IDs | s-07 | Medium | packages/observability, /metrics |
| s-09 | AuthN/AuthZ & Tenant Context | Sessions, API keys, RBAC matrix (5 roles), tenant scoping | s-07 | Medium | auth+admin endpoints, permission matrix |
| s-10 | Event Gateway & Webhook Ingestion | Stripe/Razorpay webhooks: signatures, normalization, dedupe, <300ms ack | s-06..s-08 | High | /webhooks/*, normalizers, core upserts |
| s-11 | Internal Event Bus & Replay | Redpanda+inprocess drivers, retry/backoff/DLQ, POST /events, /events/replay | s-10 | High | EventBus abstraction + consumer framework |
| s-12 | Risk Engine v1 | Deterministic weighted scoring, bands, factor explainability | s-11 | Medium | risk consumers + GET /risks |
| s-13 | Customer Context Service | Allowlisted 8KB context builder, PII masking, freshness/cache | s-06,s-09 | Medium | GET /customers/:id/context, AI input contract |
| s-14 | AI Decision Service: Core Path | Prompt registry, JSON-schema structured outputs, validation ladder, fallback, persistence | s-03,s-12,s-13 | High | POST /ai/decide end-to-end |
| s-15 | AI Governance & Evaluation | Cost ledger, confidence gate, golden-set eval harness, adversarial suite | s-14 | Medium-High | services/eval, decision read APIs |
| s-16 | Policy Engine | 9 deterministic rules w/ versioning, evaluate API, fail-closed | s-03,s-15 | High | packages/policy + policy APIs |
| s-17 | Case Orchestration Pipeline | Idempotent case creation, staged resume pipeline, case/control APIs | s-12,s-14..s-16 | High | orchestrator consumer + /cases |
| s-18 | Payment Adapters | PaymentProvider interface; Stripe/Razorpay/Mock; double-charge-proof retries | s-06 | High | packages/integrations/payments |
| s-19 | Messaging Adapters & Ledger | MessagingProvider; WhatsApp/Email/Mock; template registry; delivery+inbound webhooks | s-06,s-10-patterns | High | packages/integrations/messaging |
| s-20 | Temporal Foundation | Worker service, activity framework, retry policies, signals, test harness | s-02,s-06,s-18,s-19 | High | services/worker |
| s-21 | Human Escalation & Approvals | human_tasks lifecycle, signal-based waits, SLA sweeper, approve/reject APIs | s-20,s-09 | Medium-High | /human-tasks, approval flows |
| s-22 | Workflow A: Failed Payment | Full recovery workflow + 12-scenario financial test matrix | s-18..s-21,s-26-contract | Very High | FailedPaymentRecoveryWorkflow |
| s-23 | Workflow B: Checkout Abandonment | Watch→abandon→reminder→optional incentive; purchase-race guards | s-22 patterns | High | CheckoutAbandonmentWorkflow |
| s-24 | Workflow C: Overdue Invoice & PTP | Reminder ladder, promise-to-pay child workflow, dispute stops, cron reconciler | s-22,s-21 | Very High | OverdueInvoiceWorkflow + PTP lifecycle |
| s-25 | Audit Trail & Timeline Completion | DB-level immutability, coverage checker, timeline merge API | s-17..s-24 emitters | Medium | audit roles/triggers, /cases/:id/timeline |
| s-26 | Outcomes, Attribution & Cost Model | recordOutcome choke point, WORKFLOW_LINKED + ATTRIBUTION_WINDOW sweepers | s-15,s-18,s-19 | High | authoritative economics layer |
| s-27 | Analytics Service & APIs | Six metric endpoints from views; frozen metric definitions; caching | s-26,s-12..s-16 | Medium-High | /analytics/* |
| s-28 | Dashboard UI | 8 pages + login; executive/ops/AI views; live case timeline; task inbox | s-09..s-27 APIs | High | apps/frontend full build |
| s-29 | Demo Mode, Simulators & Seed Data | Mock wiring, /demo/* endpoints, injection toggles, spec-volume seeds, scenarios A/B/C | all functional steps | High | runnable demo + CI fixtures |
| s-30 | Security Hardening & Compliance | Cross-tenant probes, secret sweeps, rate-limit policy, checklist-with-evidence | s-25,s-29 | Medium-High | SECURITY-CHECKLIST.md, RLS ADR |
| s-31 | Resilience, Chaos & Concurrency Testing | All 14 spec §21 failure scenarios automated; kill drills; stuck-action sweeper | s-29,s-31-harness | High | chaos suites, RESILIENCE.md |
| s-32 | E2E Acceptance Tests | Spec §29 18-item journey + spec §8 blocks + UI smoke as release gate | s-28,s-31 | High | tests/e2e, test:e2e |
| s-33 | CI/CD & Deployment | Pipeline with quality gates, images, staging/prod matrix, migration & rollback policy | s-30,s-32 | High | workflows, Dockerfiles, deploy docs |
| s-34 | Monitoring, Alerting & Runbooks | Grafana dashboards-as-code, alert rules + runbooks, measured perf vs targets | s-33,s-08 | Medium-High | dashboards, alerts, PERFORMANCE.md |
| s-35 | Final Hardening, Demo Readiness & Release | Coverage re-audit, quality sweep, 9-scene demo rehearsal, v0.1.0 sign-off | all | Medium | RELEASE-v0.1.0.md, tagged release |

## Dependency diagram

```text
                       ┌────────────────────────────┐
                       │ s-01 Architecture Baseline │
                       └─────────────┬──────────────┘
                                     ▼
                 ┌───────────────────────────────────┐
                 │ s-02 Infra/Config   s-03 Domain   │
                 └─────────┬─────────────────┬───────┘
                           ▼                 │
              ┌─────────────────────────┐    │
              │ s-04 Financial Schema   │    │
              └────────────┬────────────┘    │
                           ▼                 │
              ┌─────────────────────────┐    │
              │ s-05 Recovery Schema    │    │
              └────────────┬────────────┘    │
                           ▼                 ▼
              ┌───────────────────────────────────┐
              │ s-06 Repositories & Migrations    │
              └─────────────┬─────────────────────┘
                            ▼
              ┌───────────────────────────────────┐
              │ s-07 Fastify Skeleton             │
              └───────┬───────────────┬───────────┘
                      ▼               ▼
             ┌────────────────┐ ┌──────────────┐
             │ s-08 Observab. │ │ s-09 AuthN/Z │
             └───────┬────────┘ └──────┬───────┘
                     ▼                 │
        ┌──────────────────────────┐   │
        │ s-10 Event Gateway       │   │
        └────────────┬─────────────┘   │
                     ▼                 │
        ┌──────────────────────────┐   │
        │ s-11 Event Bus           │   │
        └──┬───────────┬───────────┘   │
           ▼           │               │
   ┌───────────────┐   │   ┌────────────────────┐
   │ s-12 Risk Eng.│   │   │ s-13 Context Svc   │◄─┘
   └───────┬───────┘   │   └─────────┬──────────┘
           └─────┬─────┘             │
                 ▼                   │
        ┌──────────────────┐         │
        │ s-14 AI Decision │─────────┘
        └────────┬─────────┘
                 ▼
        ┌──────────────────┐     ┌─────────────────────────────┐
        │ s-15 AI Govern.  │────►│ s-16 Policy Engine          │
        └──────────────────┘     └──────────────┬──────────────┘
                                                ▼
        ┌───────────────────────────────────────────────────┐
        │ s-17 Case Orchestration Pipeline                  │
        └───────────────────────────┬───────────────────────┘
                                    │
   ┌────────────────┐ ┌─────────────▼──────────┐ ┌──────────────────┐
   │ s-18 Payments  │ │ s-20 Temporal Found.   │ │ s-19 Messaging   │
   └───────┬────────┘ └─────────────┬──────────┘ └────────┬─────────┘
           └───────────────┬────────┴──────────┬──────────┘
                           ▼                   
                  ┌─────────────────┐          
                  │ s-21 Approvals  │          
                  └────────┬────────┘          
                           ▼                  
        ┌───────────────────────────────────────┐
        │ s-22 WF-A Payment → s-23 WF-B Checkout│
        │              → s-24 WF-C Invoice/PTP  │
        └───────────────────┬───────────────────┘
                            ▼
   ┌──────────────┐ ┌───────────────┐ ┌──────────────────┐
   │ s-25 Audit   │►│ s-26 Outcomes │►│ s-27 Analytics   │
   └──────────────┘ └───────┬───────┘ └────────┬─────────┘
                            ▼                  ▼
                    ┌──────────────────────────────┐
                    │ s-28 Dashboard UI            │
                    └──────────────┬───────────────┘
                                   ▼
                    ┌──────────────────────────────┐
                    │ s-29 Demo Mode & Seed Data   │
                    └──────────────┬───────────────┘
                                   ▼
        ┌────────────────┐ ┌────────────────┐ ┌───────────────────┐
        │ s-30 Security  │ │ s-31 Chaos     │►│ s-32 E2E Acceptance│
        └───────┬────────┘ └───────┬────────┘ └─────────┬─────────┘
                └─────────────┬────┴────────────────────┘
                              ▼
                    ┌───────────────────────┐
                    │ s-33 CI/CD & Deploy   │
                    └───────────┬───────────┘
                                ▼
                    ┌───────────────────────┐
                    │ s-34 Monitoring/Ops   │
                    └───────────┬───────────┘
                                ▼
                    ┌───────────────────────┐
                    │ s-35 Release v0.1.0   │
                    └───────────────────────┘
```

## Implementation order rationale

```text
Foundation      (s-01..03)  : decisions + vocabulary first — no code debates later
Database        (s-04..06)  : Postgres is source of truth; anchors for every guarantee
Core Backend    (s-07..09)  : Fastify host, telemetry, authz before any business route
Integrations-in (s-10..11)  : events enter safely (signed, deduped, replayable)
Event Processing(s-12..13)  : detection + privacy-bounded context
AI Decisioning  (s-14..15)  : bounded recommender + measurable governance
Policy Engine   (s-16)      : the non-overridable gate
Orchestration   (s-17)      : Detection hands to Execution via one pipeline
Adapters        (s-18..19)  : provider-specific execution behind interfaces
Durability      (s-20..21)  : Temporal substrate + human escape hatch BEFORE workflows
Workflows A/B/C (s-22..24)  : three MVP surfaces on proven primitives
Truth & Views   (s-25..27)  : immutable audit, authoritative money math, analytics
Product Surface (s-28..29)  : dashboard + fully mockable demo capability
Verification    (s-30..32)  : security evidence, chaos proof, acceptance journeys
Ship            (s-33..35)  : pipeline, monitoring with runbooks, rehearsed release
```

## Cross-cutting invariants (enforced by named steps)

| Invariant | Enforced in |
|-----------|-------------|
| Duplicate webhook ⇒ one event, one case | s-05 unique anchors, s-10, s-17 (tested), s-31 chaos |
| No double charge ever | attempt idempotency keys (s-04/s-18), claim guards (s-06), workflow tests (s-22), chaos (s-31) |
| No duplicate customer contact | message idempotency keys + caps (s-05/s-16/s-19) |
| LLM cannot execute anything | catalog subset (s-03), no-tool structured output (s-14), policy gate (s-16), boundary lint (s-35) |
| Recovered money counted once | outcome uniqueness (s-05), single choke point (s-26) |
| Every sensitive action auditable & immutable | append-only + roles/triggers (s-05/s-25), coverage checker (s-25) |
| System survives crashes/restarts mid-flight | Temporal durability (s-20), fault-point harness (s-31), restart journey (s-32) |
| Performance targets measured not claimed | histograms from s-08, load gate (s-34), PERFORMANCE.md |

## How to work through this roadmap

1. Execute steps strictly in order unless a step's Prerequisites section marks an explicit parallel-safe exception.
2. Each step ends with a Definition of Done checklist — do not mark complete or start dependents until every box is verifiable.
3. "Recommended architectural addition" sections are the ONLY places where requirements beyond the specs are introduced; each carries its rationale.
4. Requirement traceability lives in `docs/TRACEABILITY.md` (seeded by s-01, updated by every step's *Requirement Coverage* section).

## Source documents

- [`../00-brainstorm-and-product-vision.md`](../00-brainstorm-and-product-vision.md) — thesis, pillars, surfaces, metrics, phases
- [`../01-implementation-0-to-100.md`](../01-implementation-0-to-100.md) — build sequence, DoD, demo narrative
- [`../02-architecture-and-domain.md`](../02-architecture-and-domain.md) — service contracts, domain model, workflows, APIs
- [`../03-mvp-build-spec.md`](../03-mvp-build-spec.md) — MVP scope, schemas, acceptance tests, targets
