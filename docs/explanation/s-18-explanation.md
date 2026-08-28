# s-18 — Payment Gateway Integration Adapters: Implementation Explanation

This document provides a comprehensive, in-depth explanation of everything implemented for Step 18 (`specs/steps/s-18.md`). It is written so that any engineer or future agent can understand every component, design decision, anti-double-charge invariant, provider decline taxonomy, fee capture mechanism, and verification detail.

---

## Table of Contents

1. [What the Step Required](#1-what-the-step-required)
2. [Architectural Overview & Adapter Structure](#2-architectural-overview--adapter-structure)
3. [Payment Provider Interface & Standard Types](#3-payment-provider-interface--standard-types)
4. [Stripe Adapter Implementation](#4-stripe-adapter-implementation)
5. [Razorpay Adapter Implementation](#5-razorpay-adapter-implementation)
6. [Deterministic Mock Provider & Scripting Engine](#6-deterministic-mock-provider--scripting-engine)
7. [Provider Resolution Layer](#7-provider-resolution-layer)
8. [Payment Execution Service & Anti-Double-Charging Invariant](#8-payment-execution-service--anti-double-charging-invariant)
9. [Payment Refresh Service & Polling Semantics](#9-payment-refresh-service--polling-semantics)
10. [Payment REST Endpoints & RBAC](#10-payment-rest-endpoints--rbac)
11. [Observability, Fee Accounting & Error Handling](#11-observability-fee-accounting--error-handling)
12. [Verification Evidence & Test Coverage](#12-verification-evidence--test-coverage)
13. [Deviations and Judgment Calls](#13-deviations-and-judgment-calls)

---

## 1. What the Step Required

Step 18 implements the **Payment Gateway Integration Adapters and Financial Execution Layer** — the bridge between recovery workflow decisions and third-party payment infrastructure (Stripe, Razorpay, and deterministic mock engines).

Key requirements from `specs/steps/s-18.md`:
1. **`PaymentProvider` Interface**: Unified interface supporting `retryPayment`, `createPaymentLink`, and `getPaymentStatus` across Stripe, Razorpay, and Mock implementations.
2. **Standard Decline Taxonomy**: Pure normalization mapping heterogeneous gateway failure responses (Stripe decline codes, Razorpay error codes) into internal taxonomies (`insufficient_funds`, `card_expired`, `invalid_card_number`, `do_not_honor`, `stale_card`, `processing_error`, `risk_blocked`, `network_error`, `rate_limited`).
3. **Anti-Double-Charging & Idempotency**: Idempotency key format `{tenant}:{case}:RETRY_PAYMENT:{attempt}`. The execution layer guarantees that a duplicate invocation or concurrent race condition never triggers multiple financial charges against the customer or gateway.
4. **Deterministic Mock Provider**: Out-of-the-box support for mock execution with attempt-based scripting (e.g., attempt 1 fails `insufficient_funds`, attempt 2 succeeds), `SIMULATE_PAYMENT_TIMEOUT` failure injection, and runtime outcome overrides via `setOutcomeOverride` and demo REST endpoints.
5. **Payment Execution Service**: Orchestrates guarded action claiming (`claimActionForExecution`), idempotency row reservation (`payment_attempts` with status `REQUESTED`), network retries with exponential backoff (up to 2 retries on 5xx/network errors), payment record status updates, and fee capture into `recovery_cost_entries` (`category: 'PAYMENT_PROCESSING'`).
6. **Payment Refresh Service**: Handles asynchronous gateway resolutions (`ACCEPTED_ASYNC` or `UNKNOWN`) via bounded polling (up to N=6 attempts with exponential backoff) and safe giving-up semantics when the provider remains pending.
7. **REST Endpoints**:
   - `GET /payments/:id`: Returns payment record and attempts timeline (`VIEWER+`).
   - `GET /payments/:id/status`: Queries live provider status, refreshes database state, and records fee entry (`OPERATIONS+`, rate-limited to 30 req/min).
   - `POST /demo/mock/payments/:key/next-outcome`: Configures mock provider overrides for sandbox testing and demo flows.

---

## 2. Architectural Overview & Adapter Structure

```
                      Temporal Workflow / Recovery Pipeline
                                      │
                                      ▼
                        ┌───────────────────────────┐
                        │  PaymentExecutionService  │
                        └─────────────┬─────────────┘
                                      │
          ┌───────────────────────────┼───────────────────────────┐
          │ (1. Check Idempotency)    │ (2. Claim Action)         │ (3. Reserve Attempt)
          ▼                           ▼                           ▼
  payment_attempts             recovery_actions           payment_attempts
(findPaymentAttempt)      (claimActionForExecution)    (status: REQUESTED)
          │
          ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        resolvePaymentProvider                          │
└──────────────┬──────────────────────────────┬──────────────────────────┘
               │                              │
               ▼                              ▼
     ┌───────────────────┐          ┌───────────────────┐
     │   StripeAdapter   │          │  RazorpayAdapter  │
     │ (PaymentIntents/  │          │ (Orders/Payments/ │
     │   PaymentLinks)   │          │   PaymentLinks)   │
     └───────────────────┘          └───────────────────┘
               │                              │
               └──────────────┬───────────────┘
                              │
                              ▼
                        Mock fallback
                 ┌──────────────────────┐
                 │  MockPaymentProvider │
                 │ (Scripted/Overrides) │
                 └──────────────────────┘
                              │
                              ▼
                ┌───────────────────────────┐
                │   Payment Execution Post  │
                ├───────────────────────────┤
                │ - updatePaymentStatus     │
                │ - completeAction / fail   │
                │ - recordCostEntry (Fee)   │
                │ - recordProviderDecline   │
                └───────────────────────────┘
```

---

## 3. Payment Provider Interface & Standard Types

Location: `packages/integrations/src/payments/types.ts`

The core contract standardizes operations across all gateway providers:

```typescript
export interface PaymentProvider {
  retryPayment(input: RetryPaymentInput): Promise<RetryPaymentOutput>;
  createPaymentLink(input: CreatePaymentLinkInput): Promise<CreatePaymentLinkOutput>;
  getPaymentStatus(providerPaymentId: string): Promise<PaymentStatusOutput>;
}
```

### Standard Taxonomy & Error Mappings
- **Internal Decline Codes**: `insufficient_funds`, `card_expired`, `invalid_card_number`, `do_not_honor`, `stale_card`, `processing_error`, `risk_blocked`, `network_error`, `rate_limited`, `generic_decline`.
- **`mapStripeDeclineCode(code)`**: Translates Stripe error strings (`insufficient_funds` -> `insufficient_funds`, `expired_card` -> `card_expired`, `incorrect_number` -> `invalid_card_number`, `do_not_honor` -> `do_not_honor`, `fraudulent` -> `risk_blocked`).
- **`mapRazorpayErrorCode(code)`**: Translates Razorpay error strings (`BAD_REQUEST_ERROR` with insufficient balance -> `insufficient_funds`, `GATEWAY_ERROR` -> `processing_error`, etc.).

---

## 4. Stripe Adapter Implementation

Location: `packages/integrations/src/payments/stripe.adapter.ts`

- **Payment Retry (`retryPayment`)**:
  - Sends `Idempotency-Key` header with value matching `input.idempotencyKey` directly to Stripe's REST API (`POST https://api.stripe.com/v1/payment_intents/:id/confirm`).
  - Automatically fetches the associated balance transaction (`POST ...?expand[]=latest_charge.balance_transaction`) to extract exact gateway processing fee in integer minor units.
  - On `requires_action` or `requires_payment_method` with decline code, maps decline code through `mapStripeDeclineCode`.
- **Payment Link Creation (`createPaymentLink`)**:
  - Calls Stripe's `POST /v1/payment_links` or checkout sessions with line items and idempotency keys.
- **Payment Status Check (`getPaymentStatus`)**:
  - Queries `GET /v1/payment_intents/:id` and maps `status` (`succeeded`, `canceled`, `requires_payment_method`, etc.) to canonical `ProviderPaymentStatus`.

---

## 5. Razorpay Adapter Implementation

Location: `packages/integrations/src/payments/razorpay.adapter.ts`

- **Payment Retry (`retryPayment`)**:
  - Uses HTTP Basic Authentication (`keyId:keySecret`).
  - Calls Razorpay Orders API (`POST https://api.razorpay.com/v1/orders`) with `receipt = idempotencyKey`.
  - Returns `ACCEPTED_ASYNC` status with order ID, initiating asynchronous polling or webhook settlement since Razorpay recurring charges process asynchronously via payment links or customer mandates.
- **Payment Link Creation (`createPaymentLink`)**:
  - Calls `POST /v1/payment_links` with customer phone, email, amount in paise, and currency.
- **Payment Status Check (`getPaymentStatus`)**:
  - Queries `GET /v1/payments/:id` or `GET /v1/orders/:id/payments` to retrieve final transaction state, fee, and tax breakdown.

---

## 6. Deterministic Mock Provider & Scripting Engine

Location: `packages/integrations/src/payments/mock.provider.ts`

The `MockPaymentProvider` is built for automated tests, CI workflows, and live demo rehearsal:
1. **Scripted Attempt Cycles**: By default, attempt 1 returns `FAILED` with decline code `insufficient_funds`. Attempt 2 returns `SUCCEEDED` with synthetic fee calculation (`2% + ₹3.00`).
2. **Outcome Overrides**: Global and key-specific outcome overrides via `MockPaymentProvider.setOutcomeOverride(key, outcome)` and `clearOverrides()`.
3. **Failure Injection**: Honors `demoConfig.simulatePaymentTimeout` or environment variable `SIMULATE_PAYMENT_TIMEOUT=true` by throwing `ProviderNetworkError` to exercise timeout handling and status refresh polling.
4. **Deterministic Fees**: Computes processing fee based on currency rules ($0.30 + 2.9% for USD, ₹3.00 + 2.0% for INR).

---

## 7. Provider Resolution Layer

Location: `packages/integrations/src/payments/resolve.ts`

Resolves the active adapter instance based on configuration and mock settings:
- If `demoConfig.mockProviders === true` or credentials are unset for the requested provider (`STRIPE_SECRET_KEY` / `RAZORPAY_KEY_ID`), resolves to `MockPaymentProvider`.
- If `provider === "STRIPE"` and credentials exist, instantiates `StripeAdapter`.
- If `provider === "RAZORPAY"` and credentials exist, instantiates `RazorpayAdapter`.
- Fallbacks are deterministic and emit debug logs.

---

## 8. Payment Execution Service & Anti-Double-Charging Invariant

Location: `apps/backend/src/modules/payments/execution.service.ts`

The `PaymentExecutionService` enforces strict financial safety:

### Idempotency Key Derivation
Per Spec 01 §21:
$$\text{idempotencyKey} = \text{tenantId} + ":" + \text{caseId} + ":RETRY_PAYMENT:" + \text{attemptNumber}$$

### Concurrency & Anti-Double-Charging Guarantee
1. **Pre-Check**: Queries `findPaymentAttemptByIdempotencyKey`. If an attempt row exists and its status is not `REQUESTED`, it short-circuits immediately and returns the cached outcome with `duplicate: true`.
2. **Guarded Row Reservation**: Attempts to insert a `payment_attempts` row with `status = 'REQUESTED'`.
3. **Race Condition Resolution**: If another concurrent worker attempts the same charge simultaneously, the database raises unique constraint violation (SQLSTATE `23505`) on `(tenant_id, idempotency_key)`. The losing worker does **not** invoke the payment gateway; instead, it polls the winning attempt row until resolved and returns the single execution outcome.
4. **Action Claiming**: Executes `claimActionForExecution` (conditional update on `recovery_actions` where `status = 'PENDING'`) before contacting the gateway.
5. **Network Retries with Exponential Backoff**:
   - If the provider call encounters transient 5xx or `ProviderNetworkError`, retries up to `maxRetries = 2` with exponential jitter backoff (`500ms`, `1000ms`).
   - If retries exhaust or timeout expires (15s budget), records attempt status as `UNKNOWN` and defers to `PaymentRefreshService`.
6. **Fee Capture & Action Completion**:
   - On `SUCCEEDED`: Updates `payments.status = 'SUCCEEDED'`, updates `payment_attempts.status = 'SUCCEEDED'`, records cost entry into `recovery_cost_entries` (`PAYMENT_PROCESSING`), and completes action with serialized result.
   - On `FAILED`: Updates `payment_attempts.status = 'FAILED'`, records `providerDeclineTotal` metric, and fails action with error message.

---

## 9. Payment Refresh Service & Polling Semantics

Location: `apps/backend/src/modules/payments/refresh.service.ts`

When a payment attempt resolves to `UNKNOWN` or `ACCEPTED_ASYNC`:
- `pollPaymentStatus` initiates bounded polling up to `maxPolls = 6` with exponential backoff (`initialIntervalMs = 1000`).
- If the gateway transitions to `SUCCEEDED` or `FAILED`, updates `payment_attempts`, `payments`, `recovery_actions`, and records processing fee entries in `recovery_cost_entries`.
- If max polls expire while the gateway remains `PENDING` / `PROCESSING`, the service exits safely without throwing or falsely marking the attempt as failed, allowing webhooks or manual status checks to resolve the transaction later.

---

## 10. Payment REST Endpoints & RBAC

Location: `apps/backend/src/modules/payments/routes.ts`

| Endpoint | Method | Role Guard | Description |
|---|---|---|---|
| `/payments/:id` | `GET` | `VIEWER+` | Retrieves payment details, customer info, and full attempts timeline. Enforces multi-tenant 404 isolation. |
| `/payments/:id/status` | `GET` | `OPERATIONS+` | Queries upstream gateway status, updates database if changed, records fee entry, and returns refresh status. Rate limited to 30 requests/minute. |
| `/demo/mock/payments/:key/next-outcome` | `POST` | Open / Demo | Injects scripted override into `MockPaymentProvider` for automated testing and sandbox demonstrations. |

---

## 11. Observability, Fee Accounting & Error Handling

1. **Metrics**:
   - `providerDeclineTotal` counter (`provider`, `decline_code`) tracks gateway decline distributions.
   - Standard HTTP and database metrics recorded via `@repo/observability`.
2. **Fee Accounting**:
   - Every successful payment retry writes an authoritative entry into `recovery_cost_entries` with category `PAYMENT_PROCESSING`, amount in integer minor units (paise/cents), and currency.
3. **Trace Spans**:
   - `payments.retry_payment` and `payments.poll_status` create OpenTelemetry spans with attributes: `tenant.id`, `case.id`, `payment.id`, `attempt.number`, `idempotency.key`, and `provider`.

---

## 12. Verification Evidence & Test Coverage

### Test Suites Executed

1. **Payment Adapter Contract Tests (`packages/integrations/src/payments/payment-adapters-contract.test.ts`)**:
   - 17 tests verifying Stripe, Razorpay, and Mock implementations.
   - Tests retry idempotency headers, fee extraction, payment links, status checks, script cycles, timeout simulations, and decline code mappings.
   - **Result**: `17 passed, 0 failed` (13ms).

2. **Backend Payment Execution Integration Tests (`apps/backend/src/tests/payment-execution-integration.test.ts`)**:
   - 11 comprehensive tests verifying:
     - Idempotency short-circuiting on duplicate key.
     - Concurrent race safety preventing duplicate charges.
     - Full success lifecycle: action claiming, payment updates, and fee capture.
     - Failure lifecycle: decline code recording and action failure.
     - Status refresh polling for `UNKNOWN` attempts.
     - Polling give-up safety.
     - `GET /payments/:id` timeline query with `VIEWER` permission.
     - `GET /payments/:id` 404 cross-tenant isolation.
     - `GET /payments/:id/status` `OPERATIONS+` permission and DB refresh.
     - `GET /payments/:id/status` `403 Forbidden` rejection for `VIEWER`.
     - `POST /demo/mock/payments/:key/next-outcome` scripted overrides.
   - **Result**: `11 passed, 0 failed` (35.1s).

### Verification Commands Run

```bash
bun run check-types   # PASSED (11/11 packages & apps clean)
bun run lint          # PASSED (0 errors)
bunx vitest run       # PASSED (28/28 Step 18 tests passing)
bun run check-docs    # PASSED (19 doc links OK)
```

---

## 13. Deviations and Judgment Calls

- **BigInt JSONB Serialization**: In Drizzle ORM, JSONB columns (`recovery_actions.result`, `recovery_actions.error`) invoke `JSON.stringify`, which raises `TypeError` on raw `BigInt` values. The `fee.amount` stored inside action results is serialized to string (`fee.amount.toString()`), while the authoritative `recovery_cost_entries.amount` column retains the native `bigint` data type.
- **Machine API Key Authority**: Per ADR-012, machine API keys hold `ADMIN` role within the tenant scope, while human user session cookies hold granular roles (`VIEWER`, `OPERATIONS`, `FINANCE`, `ADMIN`). The integration tests test RBAC role rejection using authenticated user session cookies.
- **Deterministic Order Receipt**: For Razorpay, order creation utilizes the idempotency key as the order `receipt` field, ensuring gateway-level deduplication on asynchronous order creation.
