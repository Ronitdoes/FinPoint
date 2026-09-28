# Changelog

Generated for the v0.1.0 release (Step 35) from `specs/steps/progress.md`
completion log. One line per roadmap step; details live in
`docs/explanation/s-XX-explanation.md`.

## v0.1.0 — 2026-09-10 — MVP: AI Revenue Recovery, demonstrable & signed off

Release record: `docs/RELEASE-v0.1.0.md` (DoD sign-off, known limitations L1–L6,
deferral register D1–D7). Demo: `docs/demo-script.md` (9 scenes, measured numbers).

### Foundation (s-01–s-03)
- **s-01** Architecture baseline: 13 ADRs, ARCHITECTURE/CONVENTIONS/TRACEABILITY, naming map, gap review, testing skeleton.
- **s-02** Local infra + typed config: 7-service compose (Postgres, Redis, Temporal, Redpanda, frontend), namespace auto-create, `@repo/config` (zod, fail-fast, frozen), env hygiene.
- **s-03** Shared domain `@repo/domain`: branded ids, minor-unit money, 12 enums, event envelope, case state machine, closed action catalog, policy limits, entities (202 tests).

### Data layer (s-04–s-06)
- **s-04** Financial core schema: 11 tables, citext, pgEnum parity, migration 0000.
- **s-05** Recovery domain schema: 18 tables, 5 anti-duplication anchors, `net_recovered` generated column, migration 0001, ERD.
- **s-06** Migration pipeline (advisory lock, retry, `db:migrate:check`) + 23 tenant-scoped repositories, guarded transitions, per-tenant case numbering.

### Platform (s-07–s-09)
- **s-07** Fastify 5 skeleton: app factory, graceful shutdown, traceparent correlation, redacted logging, error envelope, rate limiting, `/health|/ready|/version`.
- **s-08** Observability: `@repo/observability` (OTel tracing, 15 Prometheus families, `/metrics`, Pino redaction), otel-collector, ADR-014.
- **s-09** AuthN/Z: sessions + API keys, 5 roles, mandatory tenant guard, login rate-limit, argon2id, admin seeding (386 tests).

### Ingestion (s-10–s-13)
- **s-10** Webhook gateway: Stripe + Razorpay HMAC, normalizer matrix, idempotent upserts, dedupe anchor, bus dispatch, rotation runbook.
- **s-11** Event bus + replay: in-process + Redpanda drivers, retry/backoff/DLQ, `POST /events`, `POST /events/replay` (Gate G2).
- **s-12** Risk Engine v1: weighted rules, 0–100 + bands, factor explainability, `risk.calculated` events, `/risks` APIs.
- **s-13** Customer context: batch builder, allowlists, PII masking, 8KB budget, Redis cache, `/customers/:id/context`.

### Intelligence (s-14–s-16)
- **s-14** AI decision path: versioned prompts, OpenAI-compatible client (timeout/retry/circuit-breaker), repair retry + rule fallback, cost tracking, `/ai/*`.
- **s-15** AI governance + eval: pricing table (fail-closed), confidence hooks, in-tx cost writes, 30-case golden harness + CI gate, prompt runbook.
- **s-16** Policy engine: pure `@repo/policy`, 9 seeded rules, AST matcher, snapshot versioning, evaluation ledger, `/policy/*` (<50ms).

### Execution (s-17–s-21)
- **s-17** Case orchestration: bus consumer, resumable pipeline (QUALIFIED→…→IN_PROGRESS/STOPPED/ESCALATED/FAILED), control + read APIs (Gate G3).
- **s-18** Payment adapters: Stripe/Razorpay/Mock, decline taxonomy, anti-double-charge execution, UNKNOWN polling, `/payments/*`.
- **s-19** Messaging adapters: WhatsApp/Email/Mock, trilingual templates, anti-double-send, delivery ledger FSM, inbound webhooks + STOP opt-out, `/messages/*`.
- **s-20** Temporal foundation: worker service, 15 activities, named retry policies, deterministic workflow template, determinism lint (Gate G4 groundwork).
- **s-21** Human escalation: tasks lifecycle, session-only decisions, guarded transitions, SLA sweeper, signal waits with DB fallback, `/human-tasks`.

### Workflows (s-22–s-24)
- **s-22** Workflow A (failed payment): 3-round retry, wake-up signals, UNKNOWN polling, bounded replan + approval hook (12-scenario matrix).
- **s-23** Workflow B (checkout abandonment): 30m watch, zero-discount Touch 1, ≤₹5,000 Touch 2, race guard (8 scenarios).
- **s-24** Workflow C (invoice + promise-to-pay): 3-touch ladder, PTP child workflow, dispute stop, DailyReconciler, `/promises-to-pay` (9 scenarios).

### Product (s-25–s-29)
- **s-25** Audit + timeline: field contract, immutability triggers, PII scanner, unified `/cases/:id/timeline`, ADMIN `/audit`, coverage checker, retention job.
- **s-26** Outcomes/attribution/costs: single-choke-point recording, hourly attribution sweeper, daily cost-completeness job, `/outcomes`, attribution doc.
- **s-27** Analytics: 6 SQL views, 6 `/analytics/*` endpoints, RBAC cost gating, 30s single-flight cache (15 snapshot tests).
- **s-28** Dashboard: Next.js 16 control plane (9 routes + login), auto-refresh timeline, ₹ Lakh/Crore formatting, client RBAC mirror (build green).
- **s-29** Demo mode + seeds: 4 simulators, Redis injection switches, deterministic volumes (1k/2.5k/400/180/100/45/90 + A/B/C), 9-scene script (Gate G5).

### Verification & ship (s-30–s-35)
- **s-30** Security hardening: rate-limit policy, IP-block abuse rule, 36-probe matrix, sweep + audit gates, ADR-015 (RLS deferred), digest pins (165 tests).
- **s-31** Resilience/chaos: fault-point harness, EXECUTING sweeper, kill drills, 5k backlog drain, RESILIENCE evidence (23 tests).
- **s-32** E2E acceptance: flagship journey (normal + FALLBACK + restart), 7 §8 blocks, UI smoke, 18/18 + 7/7 coverage audit (Gate G6).
- **s-33** CI/CD + deploy: unified prod image, 3 workflows, deploy runbooks, cron inventory, deploy-check + smoke + compat scripts.
- **s-34** Monitoring/ops: 14 alerts + routing, 4 Grafana dashboards, snapshot/sampler jobs, 14 runbooks, SLOs, measured PERFORMANCE, k6/load-lite gates.
- **s-35** Release (this): coverage re-audit, `boundaries:audit` gate, reset + image-build fixes, measured demo-script, RELEASE sign-off with L1–L6/D1–D7 (Gate G7, deploy-pending-operator).
