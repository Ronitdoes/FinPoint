# s-20 — Temporal Foundation (Worker Service): Implementation Explanation

This document explains, in complete depth, everything that was done to implement `specs/steps/s-20.md`. It is written so that any engineer or coding agent can understand every design decision, file layout, deterministic boundary rule, error taxonomy, and test verification technique implemented in the Temporal worker platform layer.

---

## Table of contents

1. [What the step required](#1-what-the-step-required)
2. [Architecture & Design](#2-architecture--design)
3. [Activity Catalog & Implementation](#3-activity-catalog--implementation)
4. [Named Retry Policies & Non-Retryable Error Taxonomy](#4-named-retry-policies--non-retryable-error-taxonomy)
5. [Reference Workflow Template, Signals, and Query Handlers](#5-reference-workflow-template-signals-and-query-handlers)
6. [Client Wrapper, Service Binary, and ESLint Determinism Enforcers](#6-client-wrapper-service-binary-and-eslint-determinism-enforcers)
7. [Unit & Time-Skipping Workflow Test Harness](#7-unit--time-skipping-workflow-test-harness)
8. [Problems Discovered During Verification and Their Fixes](#8-problems-discovered-during-verification-and-their-fixes)
9. [Verification Evidence (Definition of Done)](#9-verification-evidence-definition-of-done)
10. [Traceability & Forward Alignment](#10-traceability--forward-alignment)

---

## 1. What the step required

Step s-20 provides the durable execution runtime that powers the AI Revenue Recovery platform's recovery workflows (Steps 22, 23, and 24). It establishes the standalone Temporal worker service (`services/worker`), the catalog of 15 shared activities executed across all recovery strategies, deterministic workflow conventions, time-skipping test harnesses, and client initiation boundaries.

The Definition of Done checklist from `specs/steps/s-20.md`:

- [x] Worker connects to Temporal with namespace `revenue-recovery` and listens on `recovery-main`
- [x] All 15 shared activities implemented with typed input/output and retry policies
- [x] Retry policies (`STANDARD`, `PROVIDER_POLL`, `HUMAN_WAIT`, `NON_RETRYABLE`) configured
- [x] Non-retryable error types defined and thrown appropriately
- [x] Workflows use `WORKFLOW_ID(caseId) = "recover:" + caseId` naming convention
- [x] Signal handlers (`pause`, `resume`, `stop`, `human_decision`) and query handlers implemented
- [x] Workflow execution is deterministic — zero forbidden imports in `workflows/`
- [x] Unit tests for all activities and workflow time-skipping tests passing

---

## 2. Architecture & Design

### 2.1 Monorepo Workspace & Boundaries

The worker lives at `services/worker` (package `@repo/worker`).

```text
services/worker/
├── src/
│   ├── activities/            # 15 shared activity definitions & implementations
│   │   ├── load-case-snapshot.ts
│   │   ├── check-policy-again.ts
│   │   ├── execute-retry-payment.ts
│   │   ├── create-payment-link.ts
│   │   ├── send-template-message.ts
│   │   ├── refresh-payment-status.ts
│   │   ├── record-outcome.ts
│   │   ├── create-human-task.ts
│   │   ├── wait-for-human-decision.ts
│   │   ├── mark-case-waiting.ts
│   │   ├── mark-case-in-progress.ts
│   │   ├── stop-case-with-reason.ts
│   │   ├── append-timeline.ts
│   │   ├── emit-metric.ts
│   │   ├── escalate-workflow-failure.ts
│   │   └── index.ts
│   ├── client.ts                  # Temporal Client connection wrapper & stubs (`getTemporalClient`, `startRecoveryWorkflow`, `signalCase`)
│   ├── framework/             # Retry policies, error factories, shared constants
│   │   ├── retry-policies.ts
│   │   ├── errors.ts
│   │   └── index.ts                 # Barrel re-export only (canonical refs: `retry-policies.ts` + `errors.ts`)
│   ├── testing/               # Vitest activity mocks & time-skipping workflow harness
│   │   ├── activities.test.ts
│   │   ├── worker.test.ts
│   │   ├── mocks.ts
│   │   └── env.ts                   # Time-skipping `TestWorkflowEnvironment` helper (`createTestWorkflowEnvironment`)
│   ├── workflows/             # Deterministic Temporal workflows, signals, queries
│   │   ├── _template.ts
│   │   ├── index.ts
│   │   └── shared.ts
│   ├── index.ts               # Worker bootstrap and entrypoint
│   └── worker.ts              # Worker factory and activity registration
├── package.json
└── tsconfig.json
```

### 2.2 Determinism Isolation

Temporal workflows run inside a sandboxed V8 isolate or Webpack bundle where all operations must be strictly deterministic.
- **Workflow code** (`services/worker/src/workflows/**`) is forbidden from importing `@repo/db`, `@repo/integrations`, Node I/O (`node:fs`, `node:net`, `node:http`), random number generators, or raw system time (`Date.now()`).
- **Activity code** (`services/worker/src/activities/**`) performs all database transactions, payment provider calls, message dispatches, and metrics emission.
- **Lint Rule Enforcement:** The custom ESLint config (`packages/eslint-config/worker.js`) scans `**/workflows/**` and fails the build if non-deterministic packages are imported.

---

## 3. Activity Catalog & Implementation

Step 20 implements all 15 shared activities required across the recovery lifecycle:

| # | Activity Function | Primary Purpose | Repository / Integration Bound |
|---|---|---|---|
| 1 | `loadCaseSnapshot` | Loads recovery case, revenue risk, customer profile, and action history | `findCaseById`, `findRevenueRiskById`, `findCustomerById`, `listActionsForCase` |
| 2 | `checkPolicyAgain` | Re-evaluates platform policies immediately prior to action dispatch | `evaluate`, `recordPolicyEvaluation`, `listPolicyRules` |
| 3 | `executeRetryPayment` | Initiates double-charge protected payment retry via provider adapter | `PaymentExecutionService`, `resolvePaymentProvider` |
| 4 | `createPaymentLinkAndStore` | Generates self-service checkout link and records checkout row | `PaymentProvider.createPaymentLink`, `updateCheckoutStatus` |
| 5 | `sendTemplateMessage` | Validates template variables and dispatches WhatsApp or Email message | `MessagingService`, `insertMessage`, `recordDeliveryEvent` |
| 6 | `refreshPaymentStatus` | Checks upstream payment provider state for pending/unknown transactions | `PaymentRefreshService`, `getPaymentStatus`, `updatePaymentStatus` |
| 7 | `recordOutcome` | Writes final authoritative recovery outcome row | `recordOutcomeInTx` / `recordOutcome` |
| 8 | `createHumanTask` | Creates an actionable human escalation task in the database | `createHumanTask`, `recordCaseEvent` |
| 9 | `waitForHumanDecision` | Polls the database for resolution of a human task | `findHumanTaskById` |
| 10 | `markCaseWaiting` | Transitions recovery case status to `WAITING` with reason note | `updateCaseStatusGuarded`, `recordCaseEvent` |
| 11 | `markCaseInProgress` | Transitions recovery case status to `IN_PROGRESS` | `updateCaseStatusGuarded`, `recordCaseEvent` |
| 12 | `stopCaseWithReason` | Transitions recovery case to terminal `STOPPED` state | `updateCaseStatusGuarded`, `recordCaseEvent` |
| 13 | `appendTimeline` | Appends an audit event to the recovery case event ledger | `recordCaseEvent` |
| 14 | `emitMetric` | Emits OpenTelemetry counter/histogram metrics | `@repo/observability` |
| 15 | `escalateWorkflowFailure` | Records system error and escalates case upon unrecoverable crash | `updateCaseStatusGuarded`, `createHumanTask`, `recordCaseEvent` |

---

## 4. Named Retry Policies & Non-Retryable Error Taxonomy

### 4.1 Named Retry Policies

Defined in `services/worker/src/framework/retry-policies.ts` (values match
`specs/steps/s-20.md` retry-policy table and the implementation):

- **`STANDARD`**: 3 attempts, initial interval 1s, backoff coefficient 2.0, maximum interval 30s. Used for database reads/writes, metrics, and timeline updates.
- **`PROVIDER_POLL`**: 12 attempts, initial interval 10s, backoff coefficient 1.0, heartbeat-enabled (`startToCloseTimeout 5m`, `heartbeatTimeout 30s`). Used for external provider status polling.
- **`HUMAN_WAIT`**: maximum 1 attempt (no automatic retry; signal-driven), `startToCloseTimeout` 30 days, workflow timeout 30d. Used for polling human task resolution over hours/days via `human-decision` signal + DB fallback.
- **`NON_RETRYABLE`**: Maximum 1 attempt. Used for operations that must never retry on failure (e.g. fatal policy violations, validation failures).

### 4.2 Non-Retryable Error Taxonomy

Defined in `services/worker/src/framework/errors.ts`:

- `VALIDATION_FAILED`: Malformed payload or input parameter schema violation.
- `POLICY_REJECTED`: Policy engine hard rejection that cannot be bypassed by retrying.
- `TERMINAL_DECLINE`: Payment declined due to stolen card, closed account, or fraudulent card.
- `CUSTOMER_OPTED_OUT`: Customer unsubscribed or opted out from communications.
- `ENTITY_NOT_FOUND`: Target case, customer, or invoice missing from the database.

Activities use `createNonRetryableFailure(message, type)` to throw `ApplicationFailure.nonRetryable()`, which instructs Temporal to cease retries immediately.

---

## 5. Reference Workflow Template, Signals, and Query Handlers

### 5.1 Canonical Naming Convention

Workflows use the standard format:
```typescript
export const WORKFLOW_ID = (caseId: string): string => `recover:${caseId}`;
```
This ensures direct 1-to-1 mapping between a `recovery_cases` row and its Temporal workflow execution, preventing duplicate concurrent runs.

### 5.2 Signals and Queries

- **Signals:**
  - `pauseSignal = defineSignal("pause")`: Sets `isPaused = true`, causing the workflow to transition the case to `WAITING` at the next checkpoint and await resumption.
  - `resumeSignal = defineSignal("resume")`: Sets `isPaused = false`, resuming workflow execution and moving the case back to `IN_PROGRESS`.
  - `stopSignal = defineSignal<[StopSignalInput]>("stop")`: Sets `isStopped = true`, unrolling the workflow cleanly and transitioning the case to `STOPPED`.
  - `humanDecisionSignal = defineSignal<[HumanDecisionSignalInput]>("human-decision")`: Delivers operator decision payload to unblock waiting workflows.
- **Queries:**
  - `workflowStateQuery = defineQuery<WorkflowState>("getState")`: Returns current execution step, pause/stop status, and timestamps without mutating workflow history.

---

## 6. Client Wrapper, Service Binary, and ESLint Determinism Enforcers

### 6.1 Temporal Client Wrapper

`services/worker/src/client.ts` provides `getTemporalClient()`, connecting to Temporal using `@repo/config` (`temporalAddress`, `temporalNamespace`). In testing environments without a live Temporal cluster, it gracefully falls back to a mock handle interface.

### 6.2 ESLint Determinism Verification

The ESLint configuration in `packages/eslint-config/worker.js` enforces that all workflow definitions in `**/workflows/**` only import deterministic modules, prohibiting direct database access or network libraries. It additionally bans wall-clock / non-deterministic primitives in workflow bodies via `no-restricted-syntax` (`Date.now()`, `new Date()`, `Date.parse()`, `Math.random()` — use Temporal `sleep`/`condition` or activity-provided timestamps/randomness instead). Co-located workflow tests (`**/workflows/**/*.test.ts`, `**/*.spec.ts`) are explicitly excluded from these bans via an override, since the time-skipping harness needs fakes, wall-clock, and randomness.

---

## 7. Unit & Time-Skipping Workflow Test Harness

Step 20 includes 18 automated tests across two test suites:

1. **Activity Unit Tests (`services/worker/src/testing/activities.test.ts`):** 14 tests verifying every activity against mock repositories and provider adapters, validating transaction scoping, error classification, and retry behavior.
2. **Temporal Time-Skipping Workflow Tests (`services/worker/src/testing/worker.test.ts`):** 4 tests running workflows on the `@temporalio/testing` `TestWorkflowEnvironment`:
   - Happy path execution to completion with simulated time skipping.
   - Pause and resume signal transitions across checkpoints.
   - Immediate stop signal handling and clean case unwinding.
   - Non-retryable activity failure escalation.

---

## 8. Problems Discovered During Verification and Their Fixes

1. **Temporal Workflow Bundler Disallowed Imports:**
   - *Problem:* Importing `ApplicationFailure` from `@temporalio/activity` in shared framework files caused Webpack to fail when bundling workflows.
   - *Fix:* Switched the import of `ApplicationFailure` to `@temporalio/common` in `services/worker/src/framework/errors.ts`.
2. **BigInt JSON Serialization in Activity Payloads:**
   - *Problem:* PostgreSQL entity balances (`amountAtRiskMinor`, `lifetimeValueMinor`) are represented as JavaScript `bigint`. Temporal's JSON payload converter threw serialization errors when passing these objects across activity/workflow boundaries.
   - *Fix:* Configured `BigInt.prototype.toJSON = function() { return this.toString(); }` in worker and workflow initialization.
3. **Database Entity Foreign Key and ID Type Validation:**
   - *Problem:* Schema constraints require UUID syntax for `recovery_cases.source_entity_id`, `policy_evaluations.rule_versions` (UUID array), and `recovery_outcomes.payment_id` (foreign key to `payments.id`).
   - *Fix:* Aligned activity mocks, fixtures, and repositories to generate valid UUIDs and persist foreign key dependencies during outcome recording.

---

## 9. Verification Evidence (Definition of Done)

All acceptance criteria from `specs/steps/s-20.md` were executed and verified:

```bash
# 1. Type check all workspaces
bun run check-types
# Output: Green across all 12 monorepo workspaces

# 2. Lint all packages and verify workflow determinism rules
bun run lint
# Output: 0 errors, 0 warnings

# 3. Run Step 20 activity unit tests
bunx vitest run services/worker/src/testing/activities.test.ts
# Output: 14 passed (14)

# 4. Run Step 20 time-skipping workflow tests
bunx vitest run services/worker/src/testing/worker.test.ts
# Output: 4 passed (4)

# 5. Run complete monorepo test suite
bun run test
# Output: 53 test files passed, 778 tests passed (100% passing)

# 6. Check documentation links
bun run check-docs
# Output: All markdown links validated successfully
```

---

## 10. Traceability & Forward Alignment

- **Requirements Covered:** MVP Feature #8 (Temporal Worker Foundation), DoD #10 (Workflow Runtime), DoD #18 (Durable Execution & Restart Recovery).
- **Registry layering:** `services/worker/src/registry.ts` labels the s-20 foundation (workflow template + 15 shared activities) vs later additions from s-22/23/24 (failed-payment, checkout-abandonment, invoice-overdue, promise-to-pay workflows; `requestReplanDecision`, checkout/invoice/PTP activities). See the header comments in `registry.ts`.
- **Next Steps:** Step 21 (`s-21 Human Escalation & Approvals`) and Steps 22–24 (Workflows A, B, and C) build directly upon the activity catalog, retry policies, and workflow harness established here.
