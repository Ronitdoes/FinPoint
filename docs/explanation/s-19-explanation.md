# s-19 — Messaging Adapters & Delivery Ledger: Implementation Explanation

This document provides a comprehensive, in-depth explanation of the design, implementation, and verification for `specs/steps/s-19.md` (Step 19: Messaging Adapters & Delivery Ledger).

---

## Table of Contents

1. [Overview & Scope](#1-overview--scope)
2. [Architecture & Core Concepts](#2-architecture--core-concepts)
3. [Messaging Integration Package (`@repo/integrations/messaging`)](#3-messaging-integration-package-repointegrationsmessaging)
   - 3.1 Provider Interface & Domain Contracts
   - 3.2 Template Registry & Multi-Language Support
   - 3.3 Variable Allowlist Validation
   - 3.4 WhatsApp Cloud API Adapter
   - 3.5 Transactional Email Adapter (SMTP / REST)
   - 3.6 Mock Messaging Provider & Fault Injection
   - 3.7 Provider Factory & Environment Resolvers
4. [Database & Repository Enhancements (`@repo/db`)](#4-database--repository-enhancements-repodb)
5. [Backend Messaging Module (`apps/backend/src/modules/messaging`)](#5-backend-messaging-module)
   - 5.1 Idempotency Key Derivation & Anti-Duplication Pipeline
   - 5.2 Customer Opt-Out & Contact Resolution
   - 5.3 Policy Counters Defense-in-Depth Rechecks
   - 5.4 Delivery Ledger & Lifecycle State Transitions
   - 5.5 Inbound & Outbound Webhook Handlers
   - 5.6 Read Endpoints with RBAC & PII Redaction
6. [Security & Privacy Guardrails](#6-security--privacy-guardrails)
7. [Verification & Test Results](#7-verification--test-results)
8. [Traceability Matrix](#8-traceability-matrix)

---

## 1. Overview & Scope

Step 19 establishes the customer communication infrastructure for the AI Revenue Recovery engine. It implements outbound communication adapters across multiple delivery channels (WhatsApp, Email, SMS/Mock), an immutable append-only message delivery ledger, and bidirectional webhook listeners for delivery receipts, open/read tracking, and inbound customer response processing (including automated opt-out / STOP keyword workflows).

### Key Constraints & Requirements:
- **No Double-Sends**: Enforced via deterministic idempotency keys (`{tenant}:{case}:{channel}:{template}:{step}`), database uniqueness constraints, and transactional atomic `QUEUED` record insertion before provider dispatch.
- **Strict Allowlisted Templates**: AI is strictly constrained to selecting registered templates and passing validated template variables (e.g. `customer_name`, `amount_due`, `payment_url`). Free-form arbitrary message body generation is explicitly prevented.
- **Defense-in-Depth Contact Caps**: Even if the upper orchestrator or policy layer fails to enforce frequency caps, the messaging dispatch service rechecks customer contact frequency against the database (WhatsApp max 2 per 7 days, Email max 3 per 14 days) and aborts if violated.
- **Automated Opt-Out (STOP)**: Inbound webhooks containing opt-out keywords (`STOP`, `UNSUBSCRIBE`, `CANCEL`, `QUIT`, `OPT OUT`) immediately flag `customers.opted_out = true`, record a `customer_responses` record, emit domain events (`customer.opted_out`), and reject all future outbound messaging dispatches.
- **Zero PII Leakage**: Contact addresses are masked on read endpoints (`GET /messages`), logs never output raw customer emails or phone numbers, and message bodies are never written to trace spans.

---

## 2. Architecture & Core Concepts

```
                  ┌─────────────────────────────────────────────────────────┐
                  │                 Case Orchestration / Temporal          │
                  └────────────────────────────┬────────────────────────────┘
                                               │ sendCaseMessage(...)
                                               ▼
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│ apps/backend: Messaging Send Service                                                      │
│                                                                                           │
│ 1. Resolve Customer & Case (DB)                                                           │
│ 2. Validate Template & Variable Allowlist                                                 │
│ 3. Derive Idempotency Key: {tenant}:{case}:{channel}:{template}:{step}                    │
│ 4. Fast-path Check: Return existing record if already dispatched                          │
│ 5. Customer Opt-Out Check (Abort if optedOut == true)                                     │
│ 6. Resolve Destination Contact Strictly from DB (No external caller override)             │
│ 7. Policy Cap Defense-in-Depth (WhatsApp 7d < 2, Email 14d < 3)                           │
│ 8. DB: Atomic Insert messages (QUEUED)                                                     │
│ 9. Adapter Dispatch -> Update SENT / Record Delivery Event                                 │
│ 10. Provider Failure Catch -> Update FAILED / Record Failure Event                        │
└────────────────────────────┬──────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│ @repo/integrations: Messaging Adapters Layer                                              │
│                                                                                           │
│ ┌──────────────────────┐   ┌────────────────────────┐   ┌───────────────────────────────┐ │
│ │ WhatsAppCloudAdapter │   │ TransactionalEmailAdp  │   │ MockMessagingProvider         │ │
│ └──────────┬───────────┘   └───────────┬────────────┘   └───────────────┬───────────────┘ │
└────────────┼───────────────────────────┼────────────────────────────────┼─────────────────┘
             │ Meta Graph API            │ SMTP / Transactional REST      │ In-Memory Simulation
             ▼                           ▼                                ▼
┌────────────────────────┐   ┌────────────────────────┐   ┌───────────────────────────────┐
│ WhatsApp Cloud API     │   │ SMTP / Mailgun / SES   │   │ Mock Provider Ledger          │
└────────────┬───────────┘   └───────────┬────────────┘   └───────────────────────────────┘
             │ Status / Inbound Replies  │ Status Receipts
             ▼                           ▼
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│ apps/backend: Webhooks Layer                                                              │
│ - POST /webhooks/whatsapp  (HMAC-SHA256 verify, status events, STOP keyword processing)   │
│ - POST /webhooks/email     (Token auth, delivery/open/bounce tracking, unsubscribe)       │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Messaging Integration Package (`@repo/integrations/messaging`)

The messaging integration package lives in `packages/integrations/src/messaging/` and provides:

### 3.1 Provider Interface & Domain Contracts
- `MessagingProvider`: Declares the unified contract `sendTemplate(input: SendTemplateInput): Promise<SendResult>`.
- `SendTemplateInput`: Requires `tenantId`, `caseId`, `customerId`, `channel`, `templateId`, `variables`, `toAddress`, `idempotencyKey`, and optional `language`.
- `SendResult`: Returns `providerMessageId`, `status`, `acceptedAt`, optional `fee` (in micro-units), and raw provider responses.

### 3.2 Template Registry & Multi-Language Support
Registered templates include:
1. `payment_retry_notice`: Sent when an automated subscription or payment attempt fails.
2. `cart_reminder`: Sent for abandoned checkouts.
3. `invoice_reminder`: Sent for overdue invoices.
4. `ptp_confirmation`: Sent to confirm a customer's promise-to-pay schedule.

All templates support multi-language localizations (`en`, `es`, `hi`) with channel-specific rendering (plain text for WhatsApp/SMS, plain text + HTML markup for Email).

### 3.3 Variable Allowlist Validation
The function `assertValidTemplateVariables(templateId, variables)` enforces that only declared allowlisted variable keys can be passed. Supplying unauthorized variables throws a `NotAcceptableError`.

### 3.4 WhatsApp Cloud API Adapter (`WhatsAppCloudApiAdapter`)
- Integrates with Meta's Graph API (`/v19.0/{phone_number_id}/messages`).
- Configures default 10-second request timeouts and 2x retry on transient network errors.
- Maps template variables to Meta WhatsApp template parameter structures.

### 3.5 Transactional Email Adapter (`TransactionalEmailAdapter`)
- Supports SMTP and transactional email API gateways.
- Injects standard headers (`X-Entity-Ref-ID`, `List-Unsubscribe`, `Message-ID`).
- Renders dual-mode plain-text and HTML emails.

### 3.6 Mock Messaging Provider & Fault Injection (`MockMessagingProvider`)
- Records in-memory dispatched messages for contract and integration testing (`getSentHistory()`, `clearHistory()`).
- Supports deterministic fault injection via `simulateFailure: true`, `simulateNextFailures(count)`, or the environment variable `SIMULATE_MESSAGE_FAILURE=true`.

### 3.7 Provider Factory (`messagingProviderFor`)
- Inspects configuration (`config.messaging.provider`, `config.demo.demoMode`) and selects the appropriate provider instance for each channel.

---

## 4. Database & Repository Enhancements (`@repo/db`)

1. **`messages.repo.ts`**:
   - `findMessageByProviderMessageId`: Allows webhook callback handlers to resolve the local message record by provider-assigned ID (`provider_message_id`).
   - `listMessages`: Supports tenant-isolated queries with multi-attribute filtering (`caseId`, `customerId`, `channel`, `status`) and cursor pagination.
   - `listDeliveryEvents`: Retrieves chronological delivery event receipts ordered by `occurredAt ASC`.
2. **`customers.repo.ts`**:
   - `findCustomerByPhone` & `findFirstCustomerByPhone`: Implemented with fuzzy `+` prefix normalization and descending creation timestamp ordering to match inbound webhook senders to customer records.

---

## 5. Backend Messaging Module (`apps/backend/src/modules/messaging`)

### 5.1 Idempotency Key Derivation & Anti-Duplication Pipeline
Idempotency keys are computed deterministically as:
```
{tenantId}:{caseId}:{channel}:{templateId}:{step}
```
If a message with this idempotency key already exists, `sendCaseMessage` returns the existing ledger record with `isDuplicate: true` without hitting the downstream messaging provider or incrementing policy frequency counters.

### 5.2 Customer Opt-Out & Contact Resolution
- Destination email and phone addresses are loaded **strictly from the database customer profile**. Callers cannot supply custom or overridden target addresses.
- If `customer.optedOut === true`, `sendCaseMessage` rejects the operation with `CustomerOptedOutError`.

### 5.3 Policy Counters Defense-in-Depth Rechecks
Before inserting a queued message, `sendCaseMessage` queries the delivery ledger:
- **WhatsApp**: Rechecks message count within the past 7 days. If count $\ge 2$, throws `ContactCapExceededError("WHATSAPP", 2, 7)`.
- **Email**: Rechecks message count within the past 14 days. If count $\ge 3$, throws `ContactCapExceededError("EMAIL", 3, 14)`.

### 5.4 Delivery Ledger & Lifecycle State Transitions
State transitions follow the canonical finite state machine:
```
QUEUED ──► SENT ──► DELIVERED ──► READ
   │         │
   ▼         ▼
 FAILED    BOUNCED / REJECTED
```
- **QUEUED**: Recorded immediately inside the transaction prior to adapter invocation.
- **SENT**: Updated when the provider acknowledges acceptance, along with a `message_delivery_events` record.
- **FAILED**: Updated if the provider rejects the dispatch or network timeouts expire.
- **DELIVERED / READ / BOUNCED / REJECTED**: Updated asynchronously via incoming webhooks. Terminal failure states (`FAILED`, `BOUNCED`, `REJECTED`) are immutable; subsequent duplicate receipts append event rows without overwriting terminal states.

### 5.5 Inbound & Outbound Webhook Handlers
- **WhatsApp Webhooks (`/webhooks/whatsapp`)**:
  - `GET`: Handles Meta's webhook verification challenge (`hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`).
  - `POST`: Validates constant-time HMAC-SHA256 signatures (`x-hub-signature-256`).
  - Inbound keyword processing matches `STOP`, `UNSUBSCRIBE`, `CANCEL`, `QUIT`, `OPT OUT`, triggering customer opt-out, recording a `customer_responses` entry, and publishing the `customer.opted_out` domain event.
- **Email Webhooks (`/webhooks/email`)**:
  - Validates webhook tokens (`x-webhook-token` header or query token).
  - Processes delivery, open/click (`READ`), bounce, drop (`REJECTED`), and spam/unsubscribe events.

### 5.6 Read Endpoints with RBAC & PII Redaction
- `GET /messages`: Tenant-isolated listing with RBAC role authorization (`VIEWER`, `SUPPORT`, `OPERATIONS`, `FINANCE`, `ADMIN`).
- `GET /messages/:id`: Message detail with full `delivery_events` timeline.
- **PII Redaction**:
  - Destination email addresses are masked (e.g. `j***e@example.com`).
  - Phone numbers are masked (e.g. `+1***4321`).
  - Sensitive variable values (payment URLs, invoice numbers) are redacted or truncated in list views.

---

## 6. Security & Privacy Guardrails

1. **Constant-Time Verification**: Webhook HMAC signatures are verified using `crypto.timingSafeEqual` with byte-length prechecks.
2. **Strict Multi-Tenancy**: All database queries enforce tenant scoping (`WHERE tenant_id = :tenantId`). Cross-tenant access attempts return HTTP 404.
3. **No PII in Logs**: Fastify serializers redact headers (`Authorization`, `Cookie`, webhook secrets), and log messages mask all customer phone numbers and emails.

---

## 7. Verification & Test Results

### 7.1 Unit & Contract Tests
- `packages/integrations/src/messaging/messaging-adapters-contract.test.ts`:
  - 16 tests verifying multi-language template rendering, variable allowlist assertions, adapter network dispatch, and mock provider fault simulations.
  - **Result**: 16/16 passed.

### 7.2 Backend Integration Tests
- `apps/backend/src/tests/messaging-integration.test.ts`:
  - 13 comprehensive scenarios covering:
    1. Happy path send and delivery lifecycle (`QUEUED` -> `SENT` -> `DELIVERED` -> `READ`).
    2. Idempotency deduplication & spy validation on adapter dispatches.
    3. Provider failure & failure delivery event recording.
    4. Webhook signature validation (401 on invalid, 200 on Meta challenge, 200 on Email callback).
    5. Inbound `STOP` keyword opt-out automation & subsequent send rejection.
    6. Defense-in-depth policy contact cap rechecks (WhatsApp 7d, Email 14d).
    7. Message read APIs, RBAC enforcement, and tenant isolation.
    8. PII leakage sweep across all response bodies.
  - **Result**: 13/13 passed.

### 7.3 Workspace Suite Verification
- `bun run check-types`: Clean (11 packages).
- `bun run lint`: Clean (0 errors).
- `bun run test`: All 51 test files passed, 760/760 tests green.
- `bun run check-docs`: Documentation links verified.

---

## 8. Traceability Matrix

| Requirement / Spec Item | Implementation Location | Verification Test |
|---|---|---|
| MessagingProvider interface & adapters | `packages/integrations/src/messaging/` | `messaging-adapters-contract.test.ts` |
| Multi-language template registry | `packages/integrations/src/messaging/templates/` | `messaging-adapters-contract.test.ts` |
| Idempotency key & fast-path check | `apps/backend/src/modules/messaging/send.service.ts` | `messaging-integration.test.ts` (Scenario 2) |
| Defense-in-depth contact cap recheck | `apps/backend/src/modules/messaging/send.service.ts` | `messaging-integration.test.ts` (Scenario 6) |
| WhatsApp webhook & STOP opt-out | `apps/backend/src/modules/messaging/webhooks/whatsapp.routes.ts` | `messaging-integration.test.ts` (Scenario 5) |
| Email webhook & delivery status | `apps/backend/src/modules/messaging/webhooks/email.routes.ts` | `messaging-integration.test.ts` (Scenario 4) |
| Tenant-isolated message read APIs | `apps/backend/src/modules/messaging/routes.ts` | `messaging-integration.test.ts` (Scenario 7) |
| PII masking & zero leakage | `apps/backend/src/modules/messaging/routes.ts` | `messaging-integration.test.ts` (Scenario 8) |
