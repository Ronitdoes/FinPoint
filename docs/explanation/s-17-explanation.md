# s-17 — Recovery Case Orchestration Pipeline: Implementation Explanation

This document provides a comprehensive, in-depth explanation of everything implemented for Step 17 (`specs/steps/s-17.md`). It is written so that any engineer or future agent can understand every component, design decision, state transition guard, and verification detail.

---

## Table of Contents

1. [What the Step Required](#1-what-the-step-required)
2. [Architectural Overview & Event Lifecycle](#2-architectural-overview--event-lifecycle)
3. [The `@repo/orchestration` Package](#3-the-repoorchestration-package)
4. [Case Creation Service & Anti-Duplication Anchor](#4-case-creation-service--anti-duplication-anchor)
5. [Case Pipeline Service & Staged Resumable Execution](#5-case-pipeline-service--staged-resumable-execution)
6. [Case Control Service & RBAC Authorization](#6-case-control-service--rbac-authorization)
7. [Consumer Wiring on `revenue-events.v1`](#7-consumer-wiring-on-revenue-eventsv1)
8. [Case REST Endpoints](#8-case-rest-endpoints)
9. [Database Repositories, Migrations & Observability](#9-database-repositories-migrations--observability)
10. [Verification Evidence & Integration Testing](#10-verification-evidence--integration-testing)
11. [Deviations and Judgment Calls](#11-deviations-and-judgment-calls)

---

## 1. What the Step Required

Step 17 implements the **Recovery Case Orchestration Pipeline** — the core orchestrator bridging risk calculation, AI decisioning, policy gating, human tasks, and recovery workflow execution.

Key requirements from `specs/steps/s-17.md`:
1. **Event Bus Consumer**: Subscribe consumer group `orchestrator` to `revenue-events.v1`, handling `risk.calculated` events to idempotently create/open recovery cases and publish `case.opened`.
2. **Anti-Duplication Single-Case Invariant**: For any given `source_entity_type` + `source_entity_id`, ensure exactly one active recovery case can exist at any time, backed by database unique constraints with concurrency collision handling.
3. **Staged Resumable Pipeline**:
   - `QUALIFIED` → `DECISION_PENDING` (triggers AI decisioning with rule fallback).
   - `DECISION_PENDING` → `POLICY_REVIEW` (evaluates policy rules across all actions).
   - `POLICY_REVIEW` → `IN_PROGRESS` (dispatches Temporal recovery workflow via `@repo/orchestration` client).
   - Direct transitions to `ESCALATED` (creates `APPROVAL` human task when policy requires approval or discount exceeds auto-cap).
   - Direct transitions to `STOPPED` (when policy rejects 100% of actions, e.g. customer opted out).
   - Transitions to `FAILED` (when AI decision fails and fallback is disabled).
   - Resumable: Re-invoking `runPipeline` resumes from current state without duplicating already completed stages.
4. **Case Control Service**:
   - Pause case (`IN_PROGRESS` → `WAITING` with reason).
   - Resume case (`WAITING` → `IN_PROGRESS`).
   - Escalate case (`IN_PROGRESS` | `WAITING` → `ESCALATED` with reason + creates `GENERAL` human task).
   - Stop case (`*` except terminal → `STOPPED` with mandatory non-empty reason).
   - Terminal guard: Terminal cases (`RECOVERED`, `STOPPED`, `FAILED`) reject control operations with `409 CASE_TERMINAL`.
   - RBAC enforcement: `VIEWER`/`SUPPORT` cannot mutate; `FINANCE` can mutate finance actions; `ADMIN` full access.
5. **Case Read Endpoints**:
   - `GET /cases` with status filter, risk score range, customer search, pagination, and cursor support.
   - `GET /cases/:id` returning canonical detail (case, risk, customer, policy, decision, actions, timeline, stage latencies).
   - `GET /cases/:id/timeline` returning chronological timeline events.
   - Strict multi-tenant isolation (`404` across tenant boundaries).
6. **Package `@repo/orchestration`**: Dedicated package exposing typed workflow initiation interfaces for Step 17 and Step 18.

---

## 2. Architectural Overview & Event Lifecycle

```
                                  revenue-events.v1
                                          │
                                 [risk.calculated]
                                          │
                                          ▼
                             ┌─────────────────────────┐
                             │   CaseConsumerHandler   │
                             └────────────┬────────────┘
                                          │
                                          ▼
                            ┌───────────────────────────┐
                            │    CaseCreationService    │
                            │      tryCreateCase        │
                            └─────────────┬─────────────┘
                                          │
                   ┌──────────────────────┴──────────────────────┐
                   │ (Case already active)                       │ (New Case)
                   ▼                                             ▼
          Return existing case                    DB: Insert case (DETECTED -> QUALIFIED)
                                                  DB: Record case_events (CASE_OPENED)
                                                  Bus: Publish case.opened
                                                                 │
                                                                 ▼
                                                  ┌─────────────────────────────┐
                                                  │     CasePipelineService     │
                                                  │         runPipeline         │
                                                  └──────────────┬──────────────┘
                                                                 │
                               ┌─────────────────────────────────┼─────────────────────────────────┐
                               ▼                                 ▼                                 ▼
                     [AI Stage: Decide]               [Policy Stage: Gate]            [Workflow Initiation]
                  QUALIFIED -> DECISION_PENDING       DECISION_PENDING -> POLICY_REVIEW   POLICY_REVIEW -> IN_PROGRESS
                 (AiDecideService.decide)             (PolicyService.evaluatePolicy)  (@repo/orchestration client)
                               │                                 │                                 │
                   ┌───────────┴───────────┐         ┌───────────┴───────────┐                     │
                   ▼                       ▼         ▼                       ▼                     ▼
             (LLM Outage /             (Success)  (100% Rejected)        (Requires Approval)   Recovery Workflow
           Fallback Disabled)              │         │                       │                  Active
                   │                       │         ▼                       ▼                     │
                   ▼                       │      STOPPED                ESCALATED                 ▼
                 FAILED                    │  (POLICY_ALL_REJECTED) (POLICY_REQUIRES_APPROVAL) IN_PROGRESS
          (NO_DECISION_AVAILABLE)          │                     + HumanTask (APPROVAL)
```

---

## 3. The `@repo/orchestration` Package

**Location:** `packages/orchestration`

### Package Exports
- `RecoveryWorkflowClient`: Interface contract defining `startRecoveryWorkflow(input): Promise<WorkflowRunSummary>` and `getWorkflowStatus(workflowId): Promise<WorkflowStatusResult>`.
- `DefaultWorkflowClient`: Production/local workflow client implementation that initiates recovery runs, records workflow execution records, generates deterministically unique Temporal workflow IDs (`recover:<caseId>`), and gracefully handles mock environments.
- `WorkflowRunSummary`: Typed initiation result (`workflowId`, `temporalWorkflowId`, `status`, `startedAt`).

---

## 4. Case Creation Service & Anti-Duplication Anchor

**Location:** `apps/backend/src/modules/cases/creation.service.ts`

### Concurrency and Idempotency Guard
To guarantee that 5 concurrent `risk.calculated` events for the same invoice or payment result in exactly one recovery case:
1. `tryCreateCase` queries existing active cases matching `(tenantId, sourceEntityType, sourceEntityId)`.
2. If no active case is found, it attempts to insert a new case within a transaction starting at `status = 'DETECTED'` and immediately qualifying it to `'QUALIFIED'`.
3. If concurrent requests race past the select, PostgreSQL's unique constraint (`tenant_id, source_entity_type, source_entity_id, active`) triggers error code `23505`.
4. The service catches `23505`, logs a collision recovery notice, re-queries the winning case, and returns `{ case: existing, created: false }`.
5. For newly created cases:
   - Records `CASE_OPENED` in `case_events`.
   - Records `AUDIT_LOG` entry for case creation.
   - Publishes `case.opened` event to `revenue-events.v1`.

---

## 5. Case Pipeline Service & Staged Resumable Execution

**Location:** `apps/backend/src/modules/cases/pipeline.service.ts`

### Resumable State Stages
The pipeline runner inspects the case's current status and executes strictly remaining stages:

1. **Stage 1: AI Decisioning (`QUALIFIED` → `DECISION_PENDING`)**
   - Calls `AiDecideService.decide` with case snapshot and purpose `CASE_OPENING`.
   - Persists decision ID and transition to `DECISION_PENDING`.
   - Records stage duration metrics in `pipelineStageDurationMs`.
   - If AI decision fails and rule-based fallback is disabled (`config.ai.enableRuleFallback === false`), catches error and transitions case to `FAILED (NO_DECISION_AVAILABLE)` with timeline event.

2. **Stage 2: Policy Evaluation (`DECISION_PENDING` → `POLICY_REVIEW`)**
   - Resolves active policy rules and evaluates the proposed actions against customer opt-out, contact rate limits, and discount caps.
   - Transitions case to `POLICY_REVIEW`.
   - **Rejection Gating**: If all proposed actions are rejected (e.g. customer opted out), transitions case to `STOPPED (POLICY_ALL_REJECTED)` and emits `POLICY_REJECTED` timeline event.
   - **Approval Gating**: If policy marks actions as requiring approval or discount exceeds auto-cap, transitions case to `ESCALATED (POLICY_REQUIRES_APPROVAL)` and creates a pending `APPROVAL` human task.

3. **Stage 3: Workflow Dispatch (`POLICY_REVIEW` → `IN_PROGRESS`)**
   - Dispatches the approved action plan to `@repo/orchestration` (`workflowClient.startRecoveryWorkflow`).
   - Links `workflowId` to the case.
   - Transitions case to `IN_PROGRESS (WORKFLOW_STARTED)`.
   - Records `WORKFLOW_DISPATCHED` timeline event and increments `caseFunnelTotal({ stage: 'in_progress' })`.

---

## 6. Case Control Service & RBAC Authorization

**Location:** `apps/backend/src/modules/cases/control.service.ts`

### State Transition & Terminal Invariants
All mutations flow through guarded repository calls (`transitionCaseStatus`):
- `pauseCase`: Transitions `IN_PROGRESS` → `WAITING`.
- `resumeCase`: Transitions `WAITING` → `IN_PROGRESS`.
- `escalateCase`: Transitions `IN_PROGRESS` | `WAITING` → `ESCALATED` and creates a `GENERAL` human task for agent review.
- `stopCase`: Transitions any non-terminal case to `STOPPED` with a mandatory non-empty reason.
- Any attempt to mutate a case in a terminal status (`RECOVERED`, `STOPPED`, `FAILED`) is rejected with HTTP `409 CASE_TERMINAL`.

### RBAC Permission Matrix
| Role | Pause | Resume | Escalate | Stop | Read Detail | Timeline |
|---|---|---|---|---|---|---|
| `VIEWER` | ❌ 403 | ❌ 403 | ❌ 403 | ❌ 403 | ✅ 200 | ✅ 200 |
| `SUPPORT` | ❌ 403 | ❌ 403 | ✅ 200 | ❌ 403 | ✅ 200 | ✅ 200 |
| `OPERATIONS` | ✅ 200 | ✅ 200 | ✅ 200 | ❌ 403 | ✅ 200 | ✅ 200 |
| `FINANCE` | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 |
| `ADMIN` | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 |

---

## 7. Consumer Wiring on `revenue-events.v1`

**Location:** `apps/backend/src/modules/cases/consumer.ts`

- Consumer group: `orchestrator`
- Topic: `revenue-events.v1`
- Subscriptions:
  - `risk.calculated`: Validates event payload, calls `CaseCreationService.tryCreateCase`.
  - `case.opened`: Asynchronously initiates `CasePipelineService.runPipeline` in the background.

---

## 8. Case REST Endpoints

**Location:** `apps/backend/src/modules/cases/routes.ts`

| Route | Method | Required Permission | Description |
|---|---|---|---|
| `/cases` | `GET` | `READ_CASES` | List cases with status filter, risk score range, customer search, cursor pagination |
| `/cases/:id` | `GET` | `READ_CASES` | Full canonical detail (case, risk, customer, policy, decision, actions, timeline) |
| `/cases/:id/timeline` | `GET` | `READ_CASES` | Chronological case event history |
| `/cases/:id/pause` | `POST` | `UPDATE_CASE` | Pause active recovery |
| `/cases/:id/resume` | `POST` | `UPDATE_CASE` | Resume paused recovery |
| `/cases/:id/escalate` | `POST` | `ESCALATE_CASE` | Escalate case and create operator human task |
| `/cases/:id/stop` | `POST` | `STOP_CASE` | Stop case with mandatory reason |

---

## 9. Database Repositories, Migrations & Observability

### Database Repositories
- `packages/db/src/repositories/cases.repo.ts`: Added `listCasesWithCursor`, `assignCase`, `attachWorkflowToCase`, and optional `workflowId` parameter in `transitionCaseStatus`.
- `packages/db/src/repositories/policies.repo.ts`: Added `findLatestPolicyEvaluationForCase`.
- `packages/db/drizzle/0005_add_case_opened_event_type.sql`: Added `case.opened` event type to schema.

### Observability Metrics
- `pipelineStageDurationMs`: Histogram tracking duration per pipeline stage (`ai_decide`, `policy_eval`, `workflow_dispatch`).
- `caseFunnelTotal`: Counter tracking case funnel state progressions (`created`, `qualified`, `in_progress`, `escalated`, `stopped`, `failed`).

---

## 10. Verification Evidence & Integration Testing

**Test Suite:** `apps/backend/src/tests/case-orchestration-integration.test.ts`
**Result:** 15/15 tests passing (91 expect assertions, 0 failures).

### Test Matrix Breakdown
1. **Idempotent Case Creation**: 5 concurrent `risk.calculated` events for the same payment produce exactly 1 recovery case (`created: true` on winner, `created: false` on racers).
2. **Staged Recovery Pipeline**:
   - Complete happy path: `QUALIFIED` → `DECISION_PENDING` → `POLICY_REVIEW` → `IN_PROGRESS` with approved actions.
   - Resumability: Clean resumption on re-invocation without re-executing completed stages.
   - All-rejected fixture: Transitions to `STOPPED (POLICY_ALL_REJECTED)` when customer is opted out.
   - Approval fixture: Transitions to `ESCALATED (POLICY_REQUIRES_APPROVAL)` and creates `APPROVAL` human task.
   - Simulated LLM outage with fallback disabled transitions to `FAILED (NO_DECISION_AVAILABLE)`.
3. **Case Control APIs & RBAC**:
   - Pause / resume lifecycle roundtrip.
   - Escalate creates operator human task.
   - Stop enforces non-empty reason and transitions to `STOPPED`.
   - Terminal cases reject control mutations with `409 CASE_TERMINAL`.
   - RBAC permissions matrix correctly rejects unauthorized roles and allows authorized roles.
4. **Case Read APIs & Tenant Isolation**:
   - Pagination, filters, and cursor querying.
   - Full canonical detail payload format.
   - Tenant isolation verification (Tenant B accessing Tenant A case returns `404`).
   - Chronological timeline event querying.

---

## 11. Deviations and Judgment Calls

1. **Deterministic Mock LLM in Test Harness**: In `case-orchestration-integration.test.ts`, a deterministic structured mock fetch was configured to ensure instantaneous and isolated test runs without network latency or external API key dependencies.
2. **Graceful Workflow Fallback in Development**: When Temporal is running in mock mode or standalone environments, `@repo/orchestration` generates a valid synthetic run identifier and transitions the case to `IN_PROGRESS`, ensuring end-to-end integration flows without requiring an active external Temporal daemon during local unit testing.
3. **Explicit Rule Fallback Toggle**: Added `enableRuleFallback?: boolean` to `AiConfig` in `@repo/config` to allow tests and environments to explicitly disable fallback when evaluating failure recovery modes.

---

## 12. Audit Fixes (post-implementation review)

1. **Stage ledger implemented as status + append-only events (spec `metadata.pipeline[]` never migrated).**
   Spec s-17 §Stage ledger describes `recovery_cases.metadata.pipeline[]`, but no `metadata` column was ever migrated on `recovery_cases` — and a mutable JSONB blob would violate the append-only audit conventions (CONVENTIONS §9). The durable ledger is therefore:
   - the guarded case status (resume anchor: `runPipeline` resumes from the first incomplete stage, including `POLICY_REVIEW` resume), plus
   - `PIPELINE_STAGE` rows in the append-only `case_events` timeline carrying `StageLedgerEntry` payloads (`{stage, status, at, ref}`, type in `apps/backend/src/modules/cases/case.types.ts`).
   - `CasePipelineService.recordStageLedger` persists one entry per completed stage **inside the same transaction** as the stage's guarded transition + timeline + audit writes: `CONTEXT`+`AI_DECISION` with the `QUALIFIED`→`DECISION_PENDING` transition; `POLICY` with the `POLICY_REVIEW`→`STOPPED`/`ESCALATED` transition on rejection/approval, or with the final `POLICY_REVIEW`→`IN_PROGRESS` transition on allow; `ACTIONS`+`WORKFLOW` also with the final `IN_PROGRESS` transition on allow — so a crash can never halve a stage. `getPipelineLedger(tenantId, caseId)` reads the ledger back chronologically. Happy path yields 5 DONE entries in order (`CONTEXT`, `AI_DECISION`, `POLICY`, `ACTIONS`, `WORKFLOW`); rejection/approval yields 3 DONE (`CONTEXT`, `AI_DECISION`, `POLICY`); AI failure yields `AI_DECISION` `FAILED`. Re-invoking a completed pipeline appends nothing.
2. **Sync consumer dispatched to background.**
   `cases/consumer.ts` `handleCaseOpened` previously `await`ed the full pipeline (LLM + policy + workflow start) inside the event-bus handler, contradicting s-17 §Requirements 1 ("no long work inside consumer handler"). It now schedules `runPipeline` via `setImmediate` (`queueMicrotask` fallback where `setImmediate` is unavailable) and returns immediately without `await`ing the pipeline; failures are logged via pino with `tenant_id`/`case_id`/`correlation_id` (CONVENTIONS §7), and recovery is via `case.opened` redelivery or manual rerun (both resume-safe through the ledger). The `risk.calculated` → `tryCreateCase` → publish `case.opened` path still awaits only the lightweight creation transaction and is unchanged.
3. **AI → adapters boundary test.**
   The step requires "no code path connects AI module directly to adapters (lint boundary test added)". Enforcement is two-layer: the repo-wide static gate `bun run boundaries:audit` (`scripts/audit-boundaries.ts`, Rule 1: `apps/backend/src/modules/ai/**` must not import `@repo/integrations`/provider SDKs/dispatch workflows/call execution), plus the in-suite unit test `apps/backend/src/tests/ai-adapter-boundary.test.ts` mirroring Rule 1 so `bun run test` keeps the requirement green.
