# ADR-005 — Workflow engine: Temporal, self-hosted locally

- **Status:** Accepted
- **Date:** 2026-08-25
- **Deciders:** Engineering (step s-01)
- **Related specs:** `specs/01-implementation-0-to-100.md` §3, §13; `specs/02-architecture-and-domain.md` §1, §2

## Context

The architectural contract assigns "execution + durability" exclusively to the workflow engine (spec 02 §1). Recovery workflows need timers measured in days, retries, compensation, human waits (spec 01 §19), and survival across worker crashes (DoD item 18).

## Decision

1. Temporal owns all durable execution: timers, retries, durable state, compensation, human waits, workflow lifecycle.
2. Local development runs self-hosted Temporal via Docker Compose (`infra/docker`, `infra/temporal/dynamicconfig`), provisioned in s-02.
3. Namespace: `revenue-recovery`. Task queue: `recovery-main`.
4. The worker lives in `services/worker` (`workflows/` + `activities/`). Activities are small, side-effect-only units; no external network calls inside workflow code (spec 01 §13).
5. No other scheduling mechanism (cron jobs, queue-based schedulers) may execute recovery business logic; anything needing durability belongs in a workflow.

## Consequences

- Workflow logic is deterministic and unit-testable with the Temporal SDK test environment (see ADR-013).
- Human escalation waits on a Temporal signal rather than polling (spec 01 §19).
- Operational cost of running the Temporal server cluster locally is accepted; s-34 adds runbooks.

## Alternatives considered

- **Postgres-backed job queue (e.g., pg-boss):** rejected; multi-day timers, signal-based human waits, and retry policies would all have to be hand-rolled.
- **Cloud-managed Temporal only:** rejected for MVP; local Docker keeps demos self-contained (gate G5 requires fresh clone → compose → demo).
