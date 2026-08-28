# s-22 — Workflow A: Failed Payment Recovery — Implementation Explanation

This document provides a comprehensive, deep-dive explanation of everything implemented for `specs/steps/s-22.md`. It serves as the authoritative reference for the core `FailedPaymentRecoveryWorkflow`, the event-driven signal bridge, Temporal activity bindings, AI replan evaluation, anti-double-charge safety mechanisms, and the complete 12-scenario test harness.

---

## Table of Contents

1. [What the step required](#1-what-the-step-required)
2. [Architecture & Workflow Design](#2-architecture--workflow-design)
3. [Signal-First Event Topology & Payment Success Bridge](#3-signal-first-event-topology--payment-success-bridge)
4. [Temporal Determinism & State Machine Invariants](#4-temporal-determinism--state-machine-invariants)
5. [3-Round Recovery Loop & Guarded State Transitions](#5-3-round-recovery-loop--guarded-state-transitions)
6. [Single Bounded AI Replan Path & Human Approval Hook](#6-single-bounded-ai-replan-path--human-approval-hook)
7. [Activity Registry & Replan Activity Implementation](#7-activity-registry--replan-activity-implementation)
8. [Anti-Double-Charge & Concurrency Idempotency Guarantees](#8-anti-double-charge--concurrency-idempotency-guarantees)
9. [Comprehensive 12-Scenario Matrix Verification](#9-comprehensive-12-scenario-matrix-verification)
10. [Traceability & Forward Alignment](#10-traceability--forward-alignment)

---

## 1. What the step required

Step s-22 implements the first production Temporal recovery workflow: **Workflow A (Failed Payment Recovery)** as specified in Spec 01 §20, Spec 02 §2.4, Spec 03 §9, and ADR-005.

### Definition of Done Checklist
- [x] All 12 test scenarios pass deterministically on fake clock (time-skipping test harness).
- [x] Retry count never exceeds 3 under any branch or failure path.
- [x] External-channel payment during wait stops execution before the next retry is attempted.
- [x] Double-charge impossible: claim idempotency key enforced via activity proxy.
- [x] Replan invoked exactly once after round 3 failure.
- [x] Workflow registered in Temporal worker registry and exported from `@repo/worker`.
- [x] Event-reactive `PaymentSuccessSignalBridge` listening on `revenue-events.v1` for `payment.succeeded`.

---

## 2. Architecture & Workflow Design

`FailedPaymentRecoveryWorkflow` coordinates automated recovery of failed subscription and invoice charges across multi-channel communication, smart retry timing, payment execution, and operator intervention.

```text
[Risk Engine / Case Pipeline] 
              │ (StartWorkflow: paymentId, amountMinor, currency)
              ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ failedPaymentRecoveryWorkflow (recover:<case_id>)          │
  │                                                             │
  │   LOOP: Round 1..3                                          │
  │     1. Re-check stop conditions & customer opt-out status   │
  │     2. Check & send communication (WhatsApp / Email)       │
  │     3. Wait skippable delay (24h/72h)                      │
  │        ├── Early wakeup on 'external-payment-succeeded'     │
  │        └── Early wakeup on 'stop' (opt-out / disputed)      │
  │     4. Re-evaluate policy for RETRY_PAYMENT                 │
  │        └── If requiresApproval: createHumanTask + wait      │
  │     5. executeRetryPayment (Idempotency: tenant:case:round) │
  │        ├── SUCCEEDED ──────────► [RECORD_OUTCOME -> DONE]   │
  │        ├── UNKNOWN/ASYNC ──────► [POLL_STATUS (up to 3x)]   │
  │        └── FAILED ─────────────► Next Round                 │
  │                                                             │
  │   AFTER 3 FAILED ROUNDS:                                    │
  │     6. requestReplanDecision (AI + Policy Engine)           │
  │        ├── Requires approval ──► [Human Decision Signal]    │
  │        ├── Human Task ─────────► [ESCALATED Task created]   │
  │        └── Default ────────────► [STOPPED(MAX_RETRIES)]     │
  └─────────────────────────────────────────────────────────────┘
```

---

## 3. Signal-First Event Topology & Payment Success Bridge

### 3.1 Event-to-Signal Bridge (`services/worker/src/signaling/payment-success.bridge.ts`)
When a customer pays through an organic channel (e.g. self-service customer portal, direct bank transfer, or standard invoice payment link), a `payment.succeeded` domain event is published to `revenue-events.v1`.

The `PaymentSuccessSignalBridge`:
1. Subscribes to `TOPIC_MAIN` with consumer group `payment-success-signal-bridge`.
2. Filters for `event.type === "payment.succeeded"`.
3. Calls `findLiveCaseByObligation({ db }, { tenantId, sourceEntityType: "PAYMENT", sourceEntityId: paymentId })` to locate any non-terminal recovery case.
4. Dispatches the `external-payment-succeeded` signal to the active Temporal workflow.

```typescript
export class PaymentSuccessSignalBridge {
  public async handleDomainEvent(event: DomainEvent): Promise<void> {
    if (event.type !== "payment.succeeded") return;

    const activeCase = await findLiveCaseByObligation(
      { db: this.db },
      { tenantId: event.tenant_id, sourceEntityType: "PAYMENT", sourceEntityId: paymentId },
    );

    if (activeCase) {
      await this.workflowClient.signalCase({
        tenantId: event.tenant_id,
        caseId: activeCase.id,
        signal: SIGNAL_EXTERNAL_PAYMENT_SUCCEEDED,
        payload: { paymentId, amount: payload.amount, currency: payload.currency, paidAt: event.occurred_at },
      });
    }
  }
}
```

### 3.2 Instant Wakeup During Delay
In `failed-payment.ts`, the inter-round wait uses Temporal's deterministic `condition()` primitive:
```typescript
await condition(
  () => externalPaymentSucceeded || isStopped,
  waitDelay,
);
```
If an external payment occurs, `externalPaymentSucceeded` becomes `true`, resolving the condition immediately without burning time or proceeding to the scheduled retry attempt.

---

## 4. Temporal Determinism & State Machine Invariants

Per `CONVENTIONS.md` and ADR-005:
1. **Zero Non-Deterministic Calls**: No `Date.now()`, `new Date()`, `Math.random()`, or `crypto.randomUUID()` exist inside workflow code. All timestamps use `workflowInfo().runStartTimeMs` or activity return values.
2. **Proxy Activities Only**: All DB access, network I/O, external payment execution, and template rendering occur strictly inside proxied activities.
3. **Idempotent Handlers**: Signal handlers (`pauseSignal`, `resumeSignal`, `stopSignal`, `humanDecisionSignal`, `externalPaymentSucceededSignal`) update in-memory state variables only and perform no blocking operations.
4. **Guarded Transitions**: Case state updates (`IN_PROGRESS`, `WAITING`, `ESCALATED`, `STOPPED`, `RECOVERED`) are executed via guarded activities (`markCaseWaiting`, `markCaseInProgress`, `stopCaseWithReason`, `recordOutcome`).

---

## 5. 3-Round Recovery Loop & Guarded State Transitions

The workflow enforces a strict maximum of 3 retry rounds (`MAX_ROUNDS = 3`).

In each round:
1. **Pre-Flight Snapshot**: Re-fetches the latest case and customer status via `loadCaseSnapshot` to verify the customer has not opted out or disputed the charge.
2. **Communication Dispatch**: If a communication action (`SEND_WHATSAPP` / `SEND_EMAIL`) was planned, verifies policy (`checkPolicyAgain`) and sends the message template.
3. **Smart Wait Delay**: Waits for the calculated delay (default: 24h, configurable via metadata).
4. **Retry Policy Verification**: Calls `checkPolicyAgain` for `RETRY_PAYMENT`. If approval is required, spawns an `APPROVAL` task and pauses via `awaitHumanApproval`.
5. **Execution & Status Resolution**: Calls `executeRetryPayment`. If `status === "UNKNOWN"` or `"ACCEPTED_ASYNC"`, executes up to 3 polling attempts via `refreshPaymentStatus`.
6. **Outcome Recording**: On success, immediately calls `recordOutcome` with `outcome: "RECOVERED"`, emits metrics, and terminates the workflow.

---

## 6. Single Bounded AI Replan Path & Human Approval Hook

When all 3 payment attempts fail (`attemptsCount === 3`):
1. **AI / Rule Replan Activity**: The workflow calls `activities.requestReplanDecision({ tenantId, caseId, attemptsCount: 3, lastDeclineCode, lastDeclineMessage })`.
2. **Policy Evaluation**: The replan activity invokes the `@repo/policy` engine with context `{ counters: { retry_count: 3 } }` and evaluates active tenant rules.
3. **Approval Escalation**:
   - If the replan proposes an action requiring operator approval (e.g. `OFFER_INCENTIVE` with discount), it creates an `APPROVAL` human task and waits on `awaitHumanApproval`.
   - If approved by a human session, it applies the proposed action.
   - If rejected by the operator, it halts immediately with `STOPPED(HUMAN_REJECTED)`.
4. **Default Safe Termination**: If no approved alternative action is available, the replan gracefully transitions the case to `STOPPED` with reason `MAX_RETRIES`.

---

## 7. Activity Registry & Replan Activity Implementation

### 7.1 New Activity: `requestReplanDecision` (`services/worker/src/activities/replan-decision.ts`)
- Loads case, customer, and policy rules from `@repo/db`.
- Formulates replan proposal based on decline codes (e.g., `insufficient_funds`, `do_not_honor`, `card_expired`).
- Evaluates candidate actions through `@repo/policy` engine.
- Persists formal `decisions` record with rationale, policy evaluation ledger, and metadata.
- Records case timeline event `REPLAN_EVALUATED`.

### 7.2 Worker Registry Integration (`services/worker/src/registry.ts`)
`failedPaymentRecoveryWorkflow` and `requestReplanDecision` are registered in the Temporal Worker registry and exported under `@repo/worker/workflows` and `@repo/worker/activities`.

---

## 8. Anti-Double-Charge & Concurrency Idempotency Guarantees

To ensure customers are never double-charged:
1. **Workflow Idempotency**: Temporal workflow IDs are deterministic (`recover:<case_id>`), guaranteeing only one recovery workflow runs per case.
2. **Deterministic Attempt Keys**: Every retry activity invocation uses a deterministic idempotency key format:
   `"${tenantId}:${caseId}:RETRY_PAYMENT:${attemptNumber}"`
3. **Claim-Based Protection**: `executeRetryPayment` checks existing payment attempts in the database. If an attempt with the same idempotency key exists and is `SUCCEEDED` or `PENDING`, the activity refuses duplicate submission and returns the existing result.

---

## 9. Comprehensive 12-Scenario Matrix Verification

The full 12-scenario test harness in `services/worker/src/workflows/failed-payment.test.ts` passes 100% on the Temporal time-skipping test server:

| # | Scenario | Tested Flow | Assertion Verified | Result |
|---|---|---|---|:---:|
| 1 | **Happy Path** | msg → wait(24h skipped) → retry SUCCEEDED | Outcome `RECOVERED`, outcome row + metric emitted | **PASS** |
| 2 | **Fail→Fail→Fail** | 3 rounds fail → replan | Stop reason `MAX_RETRIES`, retry count exactly 3 | **PASS** |
| 3 | **Retry Then Success** | FAILED round 1 → SUCCEEDED round 2 | Outcome `RECOVERED` at attempt #2 | **PASS** |
| 4 | **Permanent Failure** | `do_not_honor` ×3 → replan STOP | Stop reason `PERMANENT_DECLINE` | **PASS** |
| 5 | **Duplicate Execution** | Same workflow ID started twice | Idempotent start returns `accepted: false` on second start | **PASS** |
| 6 | **Concurrent Attempts** | Deterministic key collision | Anti-double-charge idempotency key match verified | **PASS** |
| 7 | **Provider Timeout** | Timeout → `UNKNOWN` → poll loop | Status resolved to `SUCCEEDED`, outcome `RECOVERED` | **PASS** |
| 8 | **Provider Error** | Fatal 503 error | Activity error caught, `escalateWorkflowFailure` task created | **PASS** |
| 9 | **Opt-out Mid-Flight** | Stop signal during round wait | Immediate `STOPPED(CUSTOMER_OPTED_OUT)`, no further attempts | **PASS** |
| 10 | **External Success** | External payment signal during wait | Instant `RECOVERED` without consuming retry attempts | **PASS** |
| 11 | **Approval Flow** | Replan proposes incentive → operator rejects | Signal `humanDecisionSignal(approved: false)` → `STOPPED(HUMAN_REJECTED)` | **PASS** |
| 12 | **Restart Survival** | Worker killed mid-flight → Worker 2 resumes | Workflow recovers from timer and completes to `RECOVERED` | **PASS** |
| 13 | **Signal Bridge** | `payment.succeeded` event received | Bridge signals active workflow with payment details | **PASS** |

---

## 10. Traceability & Forward Alignment

- **Traceability Updates**: `docs/TRACEABILITY.md` has been updated with Step 22 implementation mappings.
- **Progress Tracking**: `specs/steps/progress.md` status row marked `DONE`.
- **Downstream Readiness**:
  - Step 23: Workflow B (Checkout Abandonment Recovery) reuses the signal waiting, policy checking, and outcome recording infrastructure.
  - Step 24: Workflow C (Invoice / Dunning Recovery) leverages the same multi-round retry and communication framework.
