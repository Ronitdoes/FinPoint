# s-21 — Human Escalation & Approval Primitives: Implementation Explanation

This document explains, in complete depth, everything implemented for `specs/steps/s-21.md`. It serves as the single source of truth for the human-in-the-loop subsystem, detailing data models, guarded database transitions, RBAC enforcement, session-only authorization constraints, Temporal workflow signal waits, crash-recovery fallback mechanisms, SLA sweeper jobs, and test verification evidence.

---

## Table of contents

1. [What the step required](#1-what-the-step-required)
2. [Architecture & Design](#2-architecture--design)
3. [Data Model & Schema Migrations](#3-data-model--schema-migrations)
4. [Guarded Repository Operations](#4-guarded-repository-operations)
5. [Backend Service & REST Endpoints](#5-backend-service--rest-endpoints)
6. [SLA Sweeper & Domain Event Bus](#6-sla-sweeper--domain-event-bus)
7. [Temporal Workflow Human Decision Waiting Primitive](#7-temporal-workflow-human-decision-waiting-primitive)
8. [Re-escalation Deduplication Guard](#8-re-escalation-deduplication-guard)
9. [Observability & Audit Logging](#9-observability--audit-logging)
10. [Verification Evidence (Definition of Done)](#10-verification-evidence-definition-of-done)
11. [Traceability & Forward Alignment](#11-traceability--forward-alignment)

---

## 1. What the step required

Step s-21 delivers the complete backend human-in-the-loop escalation and approval subsystem required by Spec 01 §19, Spec 02 §2/§4, Spec 03 §8, and Spec 00 Pillar B. It implements bounded autonomy: allowing AI agents and automated workflows to escalate edge cases, policy violations, dispute reviews, high-value incentives, and runtime failures to human operators with explicit guardrails.

The Definition of Done checklist from `specs/steps/s-21.md`:

- [x] Task CRUD + decisions live per contracts with audit logging
- [x] Signal-based wait implemented with crash-recovery fallback proven
- [x] Approve→resume and reject→stop flows correct including action-row side effects
- [x] SLA sweeper + metrics active
- [x] Spec 03 §8 high-value-approval acceptance test passes end-to-end (fixture-driven)

---

## 2. Architecture & Design

### 2.1 Bounded Autonomy & Escalation Topology

In the AI Revenue Recovery platform, automation operates within strictly bounded autonomy. When an action exceeds autonomy thresholds (e.g. high-value discount incentives above the policy cap) or encounters unrecoverable runtime failures, the case transitions to `ESCALATED` and a `human_tasks` record is created.

```text
[Workflow / Policy Engine] ──(exceeds boundary)──► [Create Human Task (PENDING)]
                                                               │
                                                               ▼
[Operator Dashboard / API] ──(POST /approve or /reject)──► [Decide Task (APPROVED | REJECTED)]
                                                               │
                                         ┌─────────────────────┴─────────────────────┐
                                         ▼                                           ▼
                                 [Approve Path]                              [Reject Path]
                          • Case: ESCALATED -> IN_PROGRESS            • Actions: APPROVAL_REQUIRED -> CANCELLED
                          • Actions: APPROVAL_REQUIRED -> APPROVED   • Workflow: stopCaseWithReason
                          • Temporal: signal 'human-decision'         • Temporal: signal 'human-decision'
```

### 2.2 Interactive Session Security Invariant (ADR-012)

A core security constraint implemented in Step 21 is the **Session-Only Decision Requirement**:
- Approving or rejecting a human task requires an authenticated interactive user session (`request.auth.kind === 'session'` with a non-null `userId`).
- Machine API keys (`rrk_*`, `request.auth.kind === 'api_key'`) attempting to call `/human-tasks/:id/approve` or `/human-tasks/:id/reject` are explicitly rejected with `403 Forbidden`.
- This guarantees human accountability, audit integrity, and prevents autonomous loops or external machines from self-approving restricted recovery actions.

---

## 3. Data Model & Schema Migrations

### 3.1 Schema Additions (`packages/db/src/schema/human-tasks.ts`)

Two new columns were added to the `human_tasks` table:
1. `overdueAt` (`timestamp with time zone`): Timestamp when the task breached its SLA due date, set idempotently by the `SlaSweeper`.
2. `escalationCount` (`integer default 0 not null`): Counter tracking repeated escalation bursts for the same case.

```typescript
export const humanTasks = pgTable(
  "human_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "restrict" }),
    caseId: uuid("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
    type: humanTaskTypeEnum("type").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    priority: humanTaskPriorityEnum("priority").notNull().default("MEDIUM"),
    status: humanTaskStatusEnum("status").notNull().default("PENDING"),
    assignedTo: uuid("assigned_to").references(() => users.id, { onDelete: "set null" }),
    slaDueAt: timestamp("sla_due_at", { withTimezone: true, mode: "date" }),
    overdueAt: timestamp("overdue_at", { withTimezone: true, mode: "date" }),
    escalationCount: integer("escalation_count").default(0).notNull(),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decisionNotes: text("decision_notes"),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
    temporalSignalSent: boolean("temporal_signal_sent").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  // indexes ...
);
```

### 3.2 DDL Migration (`packages/db/drizzle/0006_soft_mad_thinker.sql`)

Migration was generated using Drizzle Kit and executed with PostgreSQL advisory locking (`724193`):

```sql
ALTER TABLE "human_tasks" ADD COLUMN IF NOT EXISTS "overdue_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "human_tasks" ADD COLUMN IF NOT EXISTS "escalation_count" integer DEFAULT 0 NOT NULL;
```

---

## 4. Guarded Repository Operations

All repository mutations in `packages/db/src/repositories/human-tasks.repo.ts` and `packages/db/src/repositories/actions.repo.ts` follow the guarded conditional update pattern (`WHERE status IN ('PENDING', 'ASSIGNED')` / `WHERE status = <expected>`):

- **`decideHumanTask`**: Conditionally updates `status` to `APPROVED`, `REJECTED`, or `RESOLVED` only if the task is currently in `PENDING` or `ASSIGNED`. Returning `null` on race condition enables the service layer to return `409 Conflict`.
- **Assignment is optional — `PENDING → APPROVED` direct is the normal path:** `approveTask`/`rejectTask` accept tasks in either `PENDING` or `ASSIGNED`; operators are NOT required to assign before deciding. `assignHumanTask` moves `PENDING → ASSIGNED` for triage/routing, but approval/rejection from `PENDING` is fully supported (all integration approve/reject tests decide `PENDING` tasks directly).
- **`assignHumanTask`**: Updates `assignedTo` and moves `PENDING` tasks to `ASSIGNED`.
- **`cancelHumanTask`**: Moves active tasks to `CANCELLED` with an audit cancellation reason.
- **`updateActionsStatusForCase`**: Atomically transitions recovery action rows for a case (e.g. `APPROVAL_REQUIRED` -> `APPROVED` upon approval, or `APPROVAL_REQUIRED` -> `CANCELLED` upon rejection).
- **`findRecentHumanTaskForCase`**: Queries active tasks within a time window (e.g. 1 hour) for re-escalation burst deduplication.
- **`incrementEscalationCount`**: Atomically increments `escalation_count = escalation_count + 1`.

---

## 5. Backend Service & REST Endpoints

### 5.1 Route Module (`apps/backend/src/modules/human-tasks/routes.ts`)

The human tasks module is registered at prefix `/human-tasks` in `apps/backend/src/lib/routes.ts`.

| Method | Endpoint | RBAC Role | Auth Kind | Description |
|---|---|---|---|---|
| `GET` | `/human-tasks` | `VIEWER+` | Session / API Key | Filtered list with embedded case summaries |
| `GET` | `/human-tasks/:id` | `VIEWER+` | Session / API Key | Detailed task view with linked case & actions |
| `POST` | `/human-tasks` | `OPERATIONS+` | Session / API Key | Manual task creation with SLA duration calculation |
| `POST` | `/human-tasks/:id/approve` | `OPERATIONS+` | **Interactive Session Only** | Approves task, flips case & actions, signals Temporal |
| `POST` | `/human-tasks/:id/reject` | `OPERATIONS+` | **Interactive Session Only** | Rejects task (notes required), cancels actions, signals |
| `POST` | `/human-tasks/:id/assign` | `FINANCE+` | Session / API Key | Assigns task to specified agent |
| `POST` | `/human-tasks/:id/cancel` | `FINANCE+` | Session / API Key | Cancels task with reason |

### 5.2 Default SLA Duration Matrix

When a task is created without an explicit `slaDueAt`, the service calculates the deadline based on task type:

- `APPROVAL`: 24 hours
- `DISPUTE_REVIEW`: 72 hours
- `COMPLIANCE_REVIEW`: 48 hours
- `WORKFLOW_FAILURE`: 4 hours
- `GENERAL`: 24 hours

---

## 6. SLA Sweeper & Domain Event Bus

The `SlaSweeper` (`apps/backend/src/modules/human-tasks/sla-sweeper.ts`) performs automated background sweeps:

1. Queries overdue tasks where `slaDueAt <= asOf` and `overdueAt IS NULL` and `status IN ('PENDING', 'ASSIGNED')`.
2. Idempotently marks `overdueAt = asOf` in the database.
3. Emits a typed domain event `human-task.sla-breached` to the event bus (`revenue-events.v1`) with `entity_type: "HUMAN_TASK"`, `entity_id: <task.id>`, and `customer_id` resolved from the owning case via `findCaseById` (never `task.caseId` masquerading as a customer id; `HUMAN_TASK`/`CASE` were added to `ENTITY_TYPES` for this). The payload carries `taskId`, `caseId`, `customerId`, `taskType`, `priority`, `slaDueAt`, and `overdueAt`.
4. Increments the `slaBreachTotal` counter metric partitioned by task type.
5. Records structured audit logs for operational telemetry.

Idempotency guarantees that even if the sweeper runs concurrently across multiple backend instances, each overdue task is marked and published exactly once.

---

## 7. Temporal Workflow Human Decision Waiting Primitive

Workflows wait on human decisions without polling using the `awaitHumanApproval` primitive in `services/worker/src/workflows/shared.ts`.

### 7.1 Event-Driven Wait with Crash-Recovery Heartbeat

```typescript
export async function awaitHumanApproval(
  actCtx: ActivityContext,
  taskId: string,
  activities: { waitForHumanDecision: ... },
  getDecision: () => HumanDecisionSignalPayload | undefined,
  heartbeatInterval = "60s",
): Promise<HumanApprovalOutcome> {
  // 1. Immediate check if signal already arrived
  const immediate = getDecision();
  if (immediate && immediate.taskId === taskId) {
    return { taskId, approved: immediate.approved, ... };
  }

  // 2. Condition loop with heartbeat fallback
  while (true) {
    const signaled = await condition(() => {
      const d = getDecision();
      return d !== undefined && d.taskId === taskId;
    }, heartbeatInterval);

    if (signaled) {
      return { taskId, approved: getDecision()!.approved, ... };
    }

    // 3. Fallback recovery: query DB status if signal was dropped during worker restart
    try {
      const dbTask = await activities.waitForHumanDecision({ ...actCtx, taskId });
      if (dbTask.status === "APPROVED" || dbTask.status === "RESOLVED") {
        return { taskId, approved: true, recoveredViaFallback: true, ... };
      } else if (dbTask.status === "REJECTED" || dbTask.status === "CANCELLED") {
        return { taskId, approved: false, recoveredViaFallback: true, ... };
      }
    } catch {
      // transient error; continue waiting
    }
  }
}
```

---

## 8. Re-escalation Deduplication Guard

To prevent storming human operators when external payment gateways suffer outages, `services/worker/src/activities/escalate-workflow-failure.ts` enforces a 1-hour deduplication window:

- Checks `findRecentHumanTaskForCase` with `type = 'WORKFLOW_FAILURE'` within the past 60 minutes.
- If an active task exists: calls `incrementEscalationCount` on the existing task rather than inserting a duplicate task row.
- If no recent task exists: creates a new `WORKFLOW_FAILURE` task with a 4-hour SLA.

---

## 9. Observability & Audit Logging

Added Prometheus metrics in `packages/observability/src/metrics.ts`:

- `humanTasksOpen` (`Gauge`): Tracks count of open human tasks labeled by `type` and `priority`.
- `approvalLatencyMs` (`Histogram`): Measures latency from task creation to resolution in milliseconds.
- `slaBreachTotal` (`Counter`): Tracks total SLA breaches labeled by `type`.

Every state change creates timeline events (`HUMAN_DECISION_RECORDED`, `CASE_ESCALATED`) and structured audit log records.

---

## 10. Verification Evidence (Definition of Done)

### 10.1 Test Results

All 14 workspace test packages passed with 100% success rate:

```bash
$ bun run test
  ✓ @repo/observability (3 files, 10 tests passed)
  ✓ @repo/eval (2 files, 7 tests passed)
  ✓ @repo/domain (6 files, 41 tests passed)
  ✓ @repo/integrations (7 files, 32 tests passed)
  ✓ @repo/policy (1 file, 11 tests passed)
  ✓ @repo/orchestration (2 files, 6 tests passed)
  ✓ @repo/db (3 files, 6 tests passed)
  ✓ @repo/worker (1 file, 7 tests passed)
  ✓ backend (15 files, 138 tests passed)

Tasks: 14 successful, 14 total
```

### 10.2 Typecheck, Lint, and Docs Verification

```bash
$ bun run check-types   # 12 successful, 0 errors
$ bun run lint          # 2 successful, 0 errors
$ bun run check-docs    # All 19 relative doc links OK
$ bun run db:migrate:check # All 7 migrations applied, schema up to date
```

---

## 11. Traceability & Forward Alignment

- **s-20**: Extended the Temporal recovery worker activities and workflows with `awaitHumanApproval` and deduplicated `escalateWorkflowFailure`.
- **s-22, s-23, s-24**: Strategy workflows (Card Billing, ACH/Direct Debit, Invoice Recovery) utilize `awaitHumanApproval` when policy evaluations require human intervention.
- **s-28**: Frontend Dashboard consumes `GET /human-tasks`, `POST /human-tasks/:id/approve`, `POST /human-tasks/:id/reject`, and `POST /human-tasks/:id/assign` to power the operator review UI.
