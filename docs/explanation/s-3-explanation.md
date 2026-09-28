# s-03 — Shared Domain Package (`@repo/domain`): Implementation Explanation

This document explains, in complete depth, everything implemented in `specs/steps/s-03.md`. It is written so that any developer or agent can understand every file, data structure, mathematical formula, state transition, schema validation rule, design decision, and test suite in `@repo/domain`.

---

## Table of contents

1. [What the step required](#1-what-the-step-required)
2. [Workspace architecture & dependencies](#2-workspace-architecture--dependencies)
3. [Branded ID system (`ids.ts`)](#3-branded-id-system-idsts)
4. [Money & multi-currency representation (`money.ts`)](#4-money--multi-currency-representation-moneyts)
5. [Closed enum taxonomy & specification parity (`enums/`)](#5-closed-enum-taxonomy--specification-parity-enums)
6. [Canonical event envelope (`events/envelope.ts`)](#6-canonical-event-envelope-eventsenvelopets)
7. [Recovery case state machine (`state-machines/recovery-case.ts`)](#7-recovery-case-state-machine-state-machinesrecovery-casets)
8. [Closed action catalog & AI decidable subsets (`actions/catalog.ts`)](#8-closed-action-catalog--ai-decidable-subsets-actionscatalogts)
9. [Policy limits & safety thresholds (`policy/limits.ts`)](#9-policy-limits--safety-thresholds-policylimitsts)
10. [Domain entity models (`entities/`)](#10-domain-entity-models-entities)
11. [Cross-workspace integration & consumer wiring](#11-cross-workspace-integration--consumer-wiring)
12. [Testing strategy & verification matrix](#12-testing-strategy--verification-matrix)
13. [Verification evidence (Definition of Done)](#13-verification-evidence-definition-of-done)
14. [Design decisions & judgment calls](#14-design-decisions--judgment-calls)

---

## 1. What the step required

Step s-03 establishes the **framework-free business vocabulary** of the entire platform in a dedicated workspace (`@repo/domain`). It defines the core domain types, enums, canonical event envelope, state machine transition tables, action catalog parameter schemas, policy limits, and integer minor-unit money arithmetic.

Per Spec 01 §1 and Spec 02 §1, business logic and domain vocabularies must exist independently before persistence or transport infrastructure is built. `@repo/domain` is consumed by the backend API, Temporal workers, data access layer, and frontend — with zero runtime dependencies on Fastify, Drizzle, Temporal, or external provider SDKs (only pure TypeScript and `zod`).

### Definition of Done Checklist (from `specs/steps/s-03.md`):

- `packages/domain` builds standalone; no external runtime deps except `zod`
- All enums match spec text exactly (snapshot-tested)
- Transition table covers every cell of spec 02 §4 including failure paths
- Action catalog rejects unknown types at type level and runtime level
- Policy-limit constants equal spec 03 §6 values
- Unit tests green via root `bun run test` (202 tests)
- Root tsconfig path / workspace wiring allows `import { ... } from '@repo/domain'` in all workspaces

---

## 2. Workspace architecture & dependencies

**Directory:** `packages/domain`

```text
packages/domain/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                     # Barrel export for all domain primitives
    ├── ids.ts                       # Nominally-typed (branded) identifier types
    ├── money.ts                     # Minor-unit integer money & ISO-4217 arithmetic
    ├── money.test.ts                # 33 unit tests for money truncation & formatting
    ├── enums/                       # 12 closed enum modules & spec-parity guards
    │   ├── action-type.ts
    │   ├── actor-type.ts
    │   ├── case-event-type.ts
    │   ├── case-status.ts
    │   ├── channel.ts
    │   ├── checkout-status.ts
    │   ├── event-type.ts
    │   ├── invoice-status.ts
    │   ├── payment-status.ts
    │   ├── risk-band.ts
    │   ├── risk-type.ts
    │   ├── stop-condition.ts
    │   └── enums.test.ts            # Snapshot parity tests against specs
    ├── events/
    │   ├── envelope.ts              # DomainEvent<T> strict zod schema & parser
    │   └── envelope.test.ts         # 27 unit tests for event envelope validation
    ├── state-machines/
    │   ├── recovery-case.ts         # Transition table, assertTransition, terminal sets
    │   └── recovery-case.test.ts    # 105 unit tests (exhaustive 10x10 matrix)
    ├── actions/
    │   ├── catalog.ts               # Closed action catalog, zod schemas, AI subsets
    │   └── catalog.test.ts          # 13 unit tests for parameter & catalog validation
    ├── policy/
    │   ├── limits.ts                # MVP policy limit constants (spec 03 §6)
    │   └── limits.test.ts           # Verification of constant exact values
    └── entities/                    # 16 domain entity interfaces (pure TypeScript)
        ├── ai-decision.ts
        ├── audit-log.ts
        ├── checkout.ts
        ├── customer.ts
        ├── human-task.ts
        ├── invoice.ts
        ├── message.ts
        ├── outcome.ts
        ├── payment.ts
        ├── policy.ts
        ├── promise-to-pay.ts
        ├── recovery-action.ts
        ├── recovery-case.ts
        ├── revenue-risk.ts
        ├── subscription.ts
        └── workflow.ts
```

### Dependency Boundary
- **Runtime Dependencies:** `zod` (`^3.25.76`) only.
- **Dev Dependencies:** `@repo/typescript-config`, `@types/node`, `typescript`.
- **Zero Framework Coupling:** No imports from database drivers, HTTP frameworks, or workflow engines.

---

## 3. Branded ID system (`ids.ts`)

To prevent identifier confusion (e.g., passing a `CustomerId` to a function expecting a `PaymentId`), `ids.ts` implements nominal branding using a unique symbol pattern.

```typescript
declare const brand: unique symbol;

type Brand<T extends string, B extends string> = T & {
  readonly [brand]: B;
};

export type TenantId = Brand<string, "TenantId">;
export type CustomerId = Brand<string, "CustomerId">;
export type PaymentId = Brand<string, "PaymentId">;
export type RecoveryCaseId = Brand<string, "RecoveryCaseId">;
// ... 20 branded ID types total
```

Each branded type has a zero-cost constructor helper (`tenantId(val)`, `customerId(val)`, etc.) that acts as a runtime no-op cast while providing compile-time type boundaries.

---

## 4. Money & multi-currency representation (`money.ts`)

Per **ADR-009**, floating-point representations (`0.1 + 0.2 = 0.30000000000000004`) are strictly forbidden for financial calculations. All monetary amounts are stored as integer minor units (paise for INR, cents for USD, yen for JPY).

### 4.1 Key Types & Helpers
- `MinorUnits`: A branded `bigint` representing the base integer unit.
- `getCurrencyExponent(currency)`: Returns `0`, `2`, or `3` according to ISO-4217:
  - `0`: JPY, KRW, VND, CLP
  - `2`: INR, USD, EUR, GBP, CNY, etc.
  - `3`: BHD, IQD, JOD, KWD, LYD, OMR, TND
- `parseAmountToMinorUnits(input, currency)`: Parses numeric or decimal string input into `MinorUnits`. Crucially, sub-minor unit fractional digits are **truncated** rather than rounded, preventing artificial inflation.
- `formatMinorUnits(amount, currency)`: Presentation-edge formatter returning standard locale-appropriate representations with commas and symbols (e.g., `₹12,999.00`, `$0.01`, `¥500`).
- Exact integer arithmetic helpers: `addMinorUnits`, `subtractMinorUnits`, `compareMinorUnits`.

---

## 5. Closed enum taxonomy & specification parity (`enums/`)

Every domain enum is exported as:
1. An immutable string array (`as const`)
2. A TypeScript union type derived from the array
3. A frozen dictionary object for enum-like access (`CaseStatus.DETECTED`)
4. A type-guard function (`isCaseStatus()`, `isActionType()`, etc.)

### 5.1 Enumeration Inventory

| Enum File | Values / Count | References |
|---|---|---|
| `case-status.ts` | `DETECTED`, `QUALIFIED`, `DECISION_PENDING`, `POLICY_REVIEW`, `IN_PROGRESS`, `WAITING`, `RECOVERED`, `STOPPED`, `ESCALATED`, `FAILED` (10) | Spec 01 §12, Spec 02 §4 |
| `risk-type.ts` | `PAYMENT_FAILURE`, `CHECKOUT_ABANDONMENT`, `INVOICE_OVERDUE` (3) | Spec 02 §5, Spec 03 §1 |
| `risk-band.ts` | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` (4) | Spec 01 §8 |
| `payment-status.ts` | `CREATED`, `PENDING`, `FAILED`, `SUCCEEDED`, `REFUNDED`, `DISPUTED` (6) | Spec 01 §1 |
| `checkout-status.ts` | `STARTED`, `PAYMENT_STARTED`, `COMPLETED`, `ABANDONED`, `EXPIRED` (5) | Spec 01 §1 |
| `invoice-status.ts` | `DRAFT`, `SENT`, `DUE`, `OVERDUE`, `PAID`, `DISPUTED`, `CANCELLED` (7) | Spec 01 §1 |
| `action-type.ts` | `RETRY_PAYMENT`, `CREATE_PAYMENT_LINK`, `SEND_EMAIL`, `SEND_WHATSAPP`, `SEND_SMS`, `OFFER_INCENTIVE`, `REQUEST_PAYMENT_METHOD_UPDATE`, `CREATE_PROMISE_TO_PAY`, `CREATE_HUMAN_TASK`, `PAUSE_CASE`, `STOP_CASE` (11) | Spec 02 §6 |
| `channel.ts` | `WHATSAPP`, `EMAIL`, `SMS` (3) | Spec 01 §15 |
| `actor-type.ts` | `SYSTEM`, `AI`, `USER`, `WORKFLOW`, `PROVIDER` (5) | Spec 01 §17 |
| `stop-condition.ts` | `PAYMENT_SUCCEEDED`, `OPTED_OUT`, `MAX_RETRIES`, `DISPUTED`, `POLICY_STOP`, `PROMISE_MADE`, `MANUAL_STOP`, `ATTRIBUTION_WINDOW_EXPIRED` (8) | Spec 03 §6 |
| `event-type.ts` | 25 events partitioned into payment, checkout, subscription, invoice, and customer event domains | Spec 02 §5 |
| `case-event-type.ts` | 17 timeline event types (`PAYMENT_FAILED` through `CASE_STOPPED`) | Spec 01 §17 |

Parity tests in `enums.test.ts` assert 100% equivalence between code constants and specification definitions.

---

## 6. Canonical event envelope (`events/envelope.ts`)

Per **Spec 01 §6** and **ADR-006**, all internal events flow through a standardized envelope.

```typescript
export const domainEventSchema = z.object({
  id: z.string().min(1),
  type: z.enum(EVENT_TYPES),
  occurred_at: z.string().datetime({ offset: true }),
  source: z.string().min(1),
  tenant_id: z.string().min(1),
  customer_id: z.string().min(1),
  entity_id: z.string().min(1),
  entity_type: z.enum(ENTITY_TYPES),
  payload: z.record(z.unknown()),
  correlation_id: z.string().min(1),
  traceparent: z.string().min(1).optional(),
}).strict();
```

Key validation rules:
- `.strict()` rejects unexpected root fields.
- `occurred_at` enforces valid ISO-8601 timestamps (including timezone offsets).
- `type` must belong to the closed `EVENT_TYPES` taxonomy.
- `traceparent` is reserved for W3C distributed trace propagation (s-08).

---

## 7. Recovery case state machine (`state-machines/recovery-case.ts`)

Encodes the canonical state transition table defined in **Spec 02 §4**:

```text
DETECTED         ──► QUALIFIED | STOPPED
QUALIFIED        ──► DECISION_PENDING | STOPPED
DECISION_PENDING ──► POLICY_REVIEW | FAILED
POLICY_REVIEW    ──► IN_PROGRESS | ESCALATED | STOPPED
IN_PROGRESS      ──► WAITING | RECOVERED | STOPPED | ESCALATED | FAILED
WAITING          ──► IN_PROGRESS | RECOVERED | STOPPED | ESCALATED
ESCALATED        ──► IN_PROGRESS | RECOVERED | STOPPED
RECOVERED, STOPPED, FAILED ──► [TERMINAL]
```

### Safety Features:
- `TERMINAL_STATUSES`: `["RECOVERED", "STOPPED", "FAILED"]` cannot transition to any status.
- `canTransition(from, to)`: Pure boolean inquiry.
- `assertTransition(from, to)`: Deterministic assertion throwing `IllegalTransitionError { from, to, code: "ILLEGAL_TRANSITION" }`.
- Verified by a 10×10 exhaustive matrix test covering all 100 transition pairs.

---

## 8. Closed action catalog & AI decidable subsets (`actions/catalog.ts`)

Implements the **Closed Action Catalog** to enforce bounded autonomy (Spec 01 §10, Spec 02 §6).

### 8.1 Parameter Validation Schemas
Each action type maps to a strict Zod schema in `ACTION_PARAMETER_SCHEMAS`:
- `RETRY_PAYMENT`: `{ attempt_number: int >= 1 }`
- `CREATE_PAYMENT_LINK`: `{ amount_minor: positive int, currency: 3 chars, expires_in_hours: positive int }`
- `SEND_EMAIL` / `SEND_WHATSAPP` / `SEND_SMS`: `{ template: string, variables: Record<string, string | number>, language?: string }`
- `OFFER_INCENTIVE`: `{ kind: 'DISCOUNT' | 'COUPON', amount_minor: positive int <= MAX_AUTO_DISCOUNT_MINOR }`
- `CREATE_PROMISE_TO_PAY`: `{ promised_amount_minor: positive int, promised_by_date: YYYY-MM-DD }`
- `CREATE_HUMAN_TASK`: `{ task_type: string, title: string, description: string, priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' }`
- `PAUSE_CASE` / `STOP_CASE`: `{ reason: non-empty string }`

### 8.2 Surface-Specific Allowlist (`AI_DECIDABLE_ACTIONS`)
Limits what the AI decision layer is allowed to propose based on the risk surface:
- **`PAYMENT_FAILURE`**: `RETRY_PAYMENT`, `CREATE_PAYMENT_LINK`, `SEND_WHATSAPP`, `SEND_EMAIL`, `REQUEST_PAYMENT_METHOD_UPDATE`, `CREATE_HUMAN_TASK`, `STOP_CASE`
- **`CHECKOUT_ABANDONMENT`**: `SEND_EMAIL`, `SEND_WHATSAPP`, `OFFER_INCENTIVE`, `CREATE_HUMAN_TASK`, `STOP_CASE`
- **`INVOICE_OVERDUE`**: `SEND_EMAIL`, `SEND_WHATSAPP`, `CREATE_PAYMENT_LINK`, `OFFER_INCENTIVE`, `CREATE_PROMISE_TO_PAY`, `CREATE_HUMAN_TASK`, `STOP_CASE`

---

## 9. Policy limits & safety thresholds (`policy/limits.ts`)

Exports hard numerical boundaries for the MVP policy engine (Spec 03 §6):

```typescript
export const MAX_PAYMENT_RETRIES = 3;
export const MAX_WHATSAPP_PER_7_DAYS = 2;
export const MAX_EMAIL_PER_14_DAYS = 3;
export const MAX_AUTO_DISCOUNT_MINOR = 500_000;      // 500,000 paise = ₹5,000
export const HIGH_VALUE_APPROVAL_MINOR = 10_000_000;  // 10,000,000 paise = ₹100,000
```

---

## 10. Domain entity models (`entities/`)

Provides complete TypeScript interfaces for the 16 core business entities:
1. `Customer`: Customer profile, contact information, opt-out status.
2. `Payment`: Payment state, minor unit amounts, retry counter.
3. `PaymentAttempt`: Individual payment gateway attempt record.
4. `Subscription`: Recurring subscription state and billing period bounds.
5. `Checkout`: Cart state, total minor units, activity and expiration timestamps.
6. `Invoice`: Invoice amount, due dates, paid dates, and dispute states.
7. `RevenueRisk`: Calculated risk score, risk band, signals payload.
8. `RecoveryCase`: State machine instance, amount at risk, terminal stop condition.
9. `RecoveryAction`: Action execution record, idempotency key, actor type.
10. `AiDecision`: Stored AI diagnosis, proposed actions, prompt hash, raw response.
11. `Message`: Outbound message metadata, delivery channel, template variables.
12. `PromiseToPay`: Promised amount, due date, fulfillment/broken flags.
13. `HumanTask`: Human escalation task, priority, resolution notes.
14. `Policy`: Tenant policy rule, effect (`ALLOW`, `REJECT`, `REQUIRE_APPROVAL`).
15. `AuditLogEntry`: Append-only audit record, actor type, event payload.
16. `RecoveryOutcome`: Authoritative recovered amount, cost breakdown (LLM, messaging, discounts, handling).
17. `Workflow`: Temporal execution metadata, workflow run ID.

---

## 11. Cross-workspace integration & consumer wiring

`@repo/domain` is configured as a pure TypeScript workspace package:
- `"exports": { ".": "./src/index.ts" }`
- `"main": "./src/index.ts"`
- Added to `dependencies` of `@repo/db` and `apps/backend` using `"@repo/domain": "workspace:*"`.
- TypeScript project references allow instant type navigation without building or bundling.

---

## 12. Testing strategy & verification matrix

Testing is implemented with Vitest in `packages/domain`:

| Test File | Count | Scope |
|---|---|---|
| `policy/limits.test.ts` | 2 | Exact value check for policy constants |
| `state-machines/recovery-case.test.ts` | 105 | Exhaustive 10x10 transition matrix + property checks |
| `money.test.ts` | 33 | Multi-currency exponents, decimal truncation, formatting |
| `events/envelope.test.ts` | 27 | Envelope field validation, ISO parsing, strict rejection |
| `actions/catalog.test.ts` | 13 | Unknown action rejection, schema validation, AI subsets |
| `enums/enums.test.ts` | 9 | Snapshot parity against specification text |
| `config.test.ts` (`@repo/config`) | 13 | Config presets, fail-fast validations |
| **Total** | **202** | **100% passing tests** |

---

## 13. Verification evidence (Definition of Done)

```bash
bun run check-types   # 6/6 workspace packages pass cleanly
bun run test          # 202 unit tests pass in ~600ms
bun run lint          # ESLint passes with zero warnings
bun run check-docs    # 19 relative markdown links verified
```

---

## 14. Design decisions & judgment calls

1. **BigInt for Minor Units vs Number:** `BigInt` is used in `MinorUnits` to avoid JavaScript `Number.MAX_SAFE_INTEGER` precision limits, while Zod schemas accept integer numbers at the API/JSON boundary and convert to `BigInt`.
2. **Sub-minor Unit Truncation:** Decimal amounts with extra digits (e.g. `"4.999"` INR) are truncated to integer minor units rather than rounded, matching standard banking and gateway truncation rules.
3. **Discriminator Union in Action Catalog:** `cataloguedActionSchema` uses Zod discriminated unions over `type`, giving full TypeScript type inference when matching on action types.
4. **Strict Envelope Validation:** The event envelope disallows arbitrary top-level fields (`.strict()`) to prevent untracked payload leakage across service boundaries.
