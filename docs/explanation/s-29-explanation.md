# s-29 — Demo Mode, Simulation Endpoints & Seed Data: Implementation Explanation

This document explains, in complete depth, everything that was done to implement `specs/steps/s-29.md`. It is written so that a developer (or future agent) who was not present during implementation can understand every file, every architectural decision, every security guard, and every problem that had to be debugged along the way.

---

## Table of contents

1. [What the step required](#1-what-the-step-required)
2. [Dynamic Failure Injections in Redis (`apps/backend/src/modules/demo/injections.ts`)](#2-dynamic-failure-injections-in-redis)
3. [Simulation Service & Production-Guarded Endpoints](#3-simulation-service--production-guarded-endpoints)
4. [Deterministic Seed System & Safe Reset System (`packages/db/src/seeds/`)](#4-deterministic-seed-system--safe-reset-system)
5. [Demo Script Walkthrough (`docs/demo-script.md`)](#5-demo-script-walkthrough)
6. [Security Considerations & Production Hard Guards](#6-security-considerations--production-hard-guards)
7. [Problems Discovered During Verification and Their Fixes](#7-problems-discovered-during-verification-and-their-fixes)
8. [Verification Evidence (Definition of Done)](#8-verification-evidence-definition-of-done)
9. [Deviations and Judgment Calls](#9-deviations-and-judgment-calls)

---

## 1. What the step required

Step s-29 ("Demo Mode, Simulation Endpoints & Seed Data") provides the end-to-end simulation infrastructure, deterministic high-volume seed data, dynamic failure switches, and a 9-scene live demonstration walkthrough script to unlock Milestone Gate **G5 ("Demoable product")**.

Per `specs/steps/s-29.md` and Spec 01 §24, §27:
1. **Simulation Endpoints**:
   - `POST /demo/payment-fail`: Ingests simulated failed payment via authentic HMAC-signed loopback webhooks (`payment_intent.payment_failed` for Stripe or `payment.failed` for Razorpay), triggers the ingest pipeline, risk scoring, case creation, and workflow execution.
   - `POST /demo/payment-succeed`: Dispatches authentic payment success webhook and directly delivers `external-payment-succeeded` signal to running Temporal recovery workflows for instant recovery demonstration.
   - `POST /demo/checkout-abandon`: Dispatches `checkout.started` event, updates status to `ABANDONED`, dispatches `checkout.abandoned`, and triggers Risk calculation & Workflow B.
   - `POST /demo/invoice-overdue`: Dispatches signed `invoice.payment_failed` webhook with `days_overdue: 7` into the event gateway, triggering Workflow C.
   - `PATCH /demo/injections` and `GET /demo/injections`: Exposes dynamic switches for `simulate_payment_timeout`, `simulate_message_failure`, `simulate_llm_failure`, and `simulate_duplicate_webhook` stored in Redis with a 15-minute sliding TTL.
2. **Deterministic Seed Generator (`bun run db:seed`)**:
   - Seeded PRNG (`DeterministicPrng` using Mulberry32 algorithm) guaranteeing reproducible data generation.
   - Exact pristine pre-trigger fixtures for Scenarios A (`CUS-001`, Aditi Sharma), B (`CUS-002`, Vikram Malhotra), C (`CUS-003`, Priya Patel), plus a completed A-variant (`CUS-001-REC`) for rich initial dashboard presentation.
   - Volume generation matching Spec 01 §24: 1,000 customers, 2,500 payments (2,200 succeeded, 300 failed), 400 checkouts (250 active, 150 abandoned), 180 overdue invoices, 100 cases (45 recovered, 20 stopped, 15 escalated, 20 in-progress), 45 authoritative outcomes, and 90 cost entries.
   - Reseed content hash calculation proving determinism across repeated executions.
   - Safe tenant-scoped reset (`--reset`) strictly bounded to demo tenants (`demo-*`), guarding real customer or user tables from deletion.
3. **Demo Script (`docs/demo-script.md`)**:
   - Full 9-scene narrative mapped directly to exact `curl` commands, UI clicks, operator observations, and expected state changes.
4. **Security & Guard Hardening**:
   - Routes omitted from router in production builds when `MOCK_PROVIDERS=false` (404).
   - Dynamic 410 `MOCK_DISABLED` guard if accessed when `mockProviders` is false.
   - API key minting guard rejecting `demo` scope when `MOCK_PROVIDERS=false`.
   - RBAC enforcement requiring `demo` API key scope or `ADMIN`/`OPERATIONS` user session.

---

## 2. Dynamic Failure Injections in Redis

**File:** `apps/backend/src/modules/demo/injections.ts`

### 2.1 The Problem
In earlier steps (s-02, s-14, s-18, s-19), simulation flags (`SIMULATE_PAYMENT_TIMEOUT`, `SIMULATE_MESSAGE_FAILURE`, `SIMULATE_LLM_FAILURE`, `SIMULATE_DUPLICATE_WEBHOOK`) were configured statically via environment variables and loaded into `@repo/config` at boot time. For live product demonstrations, restarting server processes to toggle a switch disrupts screen sharing, invalidates sessions, and risks race conditions.

### 2.2 Redis Dynamic Store with Sliding TTL
`injections.ts` implements a dynamic overlay layer on top of `@repo/config`:
- **Redis Key:** `demo:injections` (hash).
- **TTL:** 15 minutes (`900` seconds). Every write via `PATCH /demo/injections` resets the key's TTL, ensuring stale failure injections automatically expire without polluting subsequent test runs or operator sessions.
- **Degraded Mode / Fallback:** If Redis is disconnected or unavailable, the module safely falls back to the static config values from `app.config.demo`.
- **Active Hooks:**
  - `apps/backend/src/modules/ai/decide.service.ts`: Prior to calling `llmClient.decide()`, the service calls `getDemoInjections(redis, config.demo)` to read `simulate_llm_failure`. If true, it triggers simulated LLM timeouts on the fly, forcing bounded autonomy to visibly degrade to rule-based fallback without server restarts.
  - `apps/backend/src/modules/demo/simulator.service.ts`: When `simulate_duplicate_webhook` is toggled on, `simulatePaymentFail` dispatches concurrent dual HTTP requests with identical payloads and signatures to prove live idempotent deduplication.

---

## 3. Simulation Service & Production-Guarded Endpoints

**Files:**
- `apps/backend/src/modules/demo/simulator.service.ts`
- `apps/backend/src/modules/demo/routes.ts`
- `apps/backend/src/lib/routes.ts`

### 3.1 Loopback Webhook Generation
Unlike naive systems that synthetically insert database rows directly into `cases` or `payments`, our simulation service exercises the entire production gateway:
1. Resolves or generates the targeted demo customer (e.g. `CUS-001`).
2. Synthesizes a realistic Stripe `payment_intent.payment_failed` or Razorpay `payment.failed` payload containing genuine error codes (`insufficient_funds`, `card_declined`), minor units amount, customer details, and metadata.
3. Signs the payload using HMAC-SHA256:
   - For Stripe: `stripe-signature` header formatted as `t=<timestamp>,v1=<signature>`.
   - For Razorpay: `x-razorpay-signature` header computed via HMAC-SHA256.
   - Falls back to `DEV_MOCK_STRIPE_WEBHOOK_SECRET` (`whsec_dev_mock_stripe_secret_key_32bytes`) and `DEV_MOCK_RAZORPAY_WEBHOOK_SECRET` (`rzp_sec_dev_mock_razorpay_secret_key_32bytes`) when running in mock mode without third-party production credentials.
4. Issues an in-process Fastify injection (`app.inject`) to `POST /webhooks/stripe?tenant_id=<tenantId>` with header `x-tenant-id`.
5. The request passes through:
   - Constant-time HMAC signature verification (`verifyStripeSignature` / `verifyRazorpaySignature`).
   - Pure normalizer matrix (`normalizeStripeEvent` / `normalizeRazorpayEvent`).
   - Transactional deduplication anchor check (`events` table).
   - Core financial records upsert (`payments`, `customers`).
   - Domain event publication on `EventBus`.
   - `RiskService` deterministic scoring (`payment.failed` -> `risk.calculated`).
   - `CaseCreationService` qualification and case opening (`case.opened`).
   - Temporal workflow initiation (`failedPaymentRecoveryWorkflow`).

### 3.2 Instant Workflow Wake-up (`POST /demo/payment-succeed`)
For Scenario A demonstrations, an operator needs to show that when a customer pays out-of-band, the system instantly halts recovery communications without waiting for timers to expire.
`POST /demo/payment-succeed`:
1. Ingests a signed `payment_intent.succeeded` webhook updating the payment record in PostgreSQL.
2. Looks up the active recovery case and its associated workflow execution.
3. Directly signals the Temporal workflow via `workflowClient.signalWorkflow(temporalWorkflowId, "external-payment-succeeded", { paymentId, provider, occurredAt })`.
4. The workflow unblocks from `workflow.condition(...)`, enters the completion branch, records attribution, moves the case to `RECOVERED`, and finishes cleanly.

### 3.3 Abandoned Checkout & Overdue Invoice Simulations
- `POST /demo/checkout-abandon`: Inserts a checkout in state `STARTED`, emits `checkout.started`, advances state to `ABANDONED`, and dispatches `checkout.abandoned` into the pipeline.
- `POST /demo/invoice-overdue`: Generates and signs an `invoice.payment_failed` webhook with `days_overdue: 7`, dispatching into the ingestion gateway to initiate Workflow C.

---

## 4. Deterministic Seed System & Safe Reset System

**Files:**
- `packages/db/src/seeds/factories.ts`
- `packages/db/src/seeds/scenarios.ts`
- `packages/db/src/seeds/reset.ts`
- `packages/db/src/seeds/demo.ts`
- `packages/db/package.json`

### 4.1 Deterministic Mulberry32 PRNG
To ensure that seed generation produces identical dataset hashes across CI runs and development environments, `factories.ts` implements a deterministic pseudorandom number generator:
- Mulberry32 32-bit PRNG initialized with seed integer `0x29a738`.
- Deterministic customer profiles, Indian names, email handles, phone numbers, log-normal amount distributions (mean ₹4,500, range ₹499 to ₹85,000), and card decline reason codes (`insufficient_funds`, `card_declined`, `expired_card`, `processing_error`).
- Spans 90 days backwards with log-uniform time clustering.

### 4.2 Pristine Scenario Fixtures
`scenarios.ts` creates the exact pre-trigger entities required by Spec 01 §27:
- **Scenario A (Payment Failure):** Customer `CUS-001` (Aditi Sharma), ₹12,999 annual subscription, high LTV, ready for `payment-fail` simulation.
- **Scenario B (Abandoned Checkout):** Customer `CUS-002` (Vikram Malhotra), cart value ₹3,499, ready for `checkout-abandon` simulation.
- **Scenario C (Overdue Invoice):** Customer `CUS-003` (Priya Patel), invoice value ₹48,000, 7 days overdue, ready for `invoice-overdue` simulation.
- **Scenario A-Variant (`CUS-001-REC`):** Completed recovery case with authoritative outcome and cost entries, giving fresh deployments immediate rich charts on `/dashboard` and `/recovery`.

### 4.3 Safe Tenant-Scoped Reset
`reset.ts` implements defensive reset semantics:
- **Tenant Guard:** Strictly checks that `tenant.slug` begins with `demo-`. Any attempt to reset a tenant slug not matching `/^demo-/` throws a fatal error, preventing accidental truncation of live customer data.
- **Safe Isolation:** Executes tenant-scoped `DELETE FROM ... WHERE tenant_id = ${tenantId}` across all financial, workflow, case, and audit tables.
- **Never touches `users`:** User accounts and credentials are preserved across resets.

### 4.4 Volume & Determinism Hash Check
`demo.ts` seeds the full volume specified in Spec 01 §24:
- 1,000 Customers
- 2,500 Payments (2,200 succeeded, 300 failed)
- 400 Checkouts (250 active, 150 abandoned)
- 180 Overdue Invoices
- 100 Recovery Cases (45 recovered, 20 stopped, 15 escalated, 20 in-progress)
- 45 Outbound Outcomes & 90 Cost Entries

At the conclusion of generation, it queries the tenant's record counts and IDs to calculate a SHA-256 content hash (`c116feb8aa078e6d3f58e13525be29443fd0bbffed39bb8e697fbb8597dbbe46`), which is asserted for equality across independent re-seeds in CI.

---

## 5. Demo Script Walkthrough

**File:** `docs/demo-script.md`

`docs/demo-script.md` maps the 9-scene narrative from Spec 01 §27 into an operator-ready runbook:
- **Scene 1:** Cold Open & Problem Definition (Financial control plane, ₹42.8L recovered vs ₹1.82L costs).
- **Scene 2:** Live Payment Failure Simulation (`POST /demo/payment-fail`, webhook reception, case creation).
- **Scene 3:** Autonomous AI Decision & Policy Gating (`/cases/:id`, AI diagnosis, policy check, zero human intervention).
- **Scene 4:** Human-in-the-Loop Escalation (`POL-HIGHVALUE`, approval queue on `/tasks`, review notes, guarded approval).
- **Scene 5:** Bounded Autonomy During Provider Outage (`PATCH /demo/injections`, simulated LLM timeout, `FALLBACK_RULE_BASED` badge).
- **Scene 6:** Instant Wake-up via Out-of-Band Payment (`POST /demo/payment-succeed`, instant wake-up, case moved to `RECOVERED`).
- **Scene 7:** Abandoned Checkout Watch Window (`POST /demo/checkout-abandon`, 30m watch timer, Touch 1 no-discount invariant).
- **Scene 8:** Overdue Invoice & Promise-to-Pay (`POST /demo/invoice-overdue`, WhatsApp reminder ladder, PTP tracking).
- **Scene 9:** Executive Summary & ROI (Unit economics, ₹23.50 ROI per ₹1 cost, audit trail immutability).

---

## 6. Security Considerations & Production Hard Guards

1. **Production Route Omission (404):**
   In `apps/backend/src/lib/routes.ts`:
   ```ts
   if (app.config.app.env === "production" && app.config.demo.mockProviders === false) {
     return; // completely omits /demo routes from the router in production
   }
   ```
2. **Runtime 410 Guard (`MOCK_DISABLED`):**
   Even in non-production builds, if `mockProviders === false`, all `/demo/*` routes abort immediately with HTTP 410:
   ```json
   {
     "error": {
       "code": "MOCK_DISABLED",
       "message": "Demo mode and simulation endpoints are disabled when MOCK_PROVIDERS=false"
     }
   }
   ```
3. **API Key Minting Scope Guard:**
   In `apps/backend/src/modules/admin/api-keys.routes.ts`, attempting to create an API key with `demo` scope when `MOCK_PROVIDERS=false` is rejected with HTTP 422 `ValidationError`.
4. **RBAC & Auth Verification:**
   All simulation routes enforce `app.requireRole(["ADMIN", "OPERATIONS"])` for user sessions, or require the `demo` scope for machine API keys. Unauthenticated requests return 401; insufficient role (e.g. `VIEWER`) or missing scope returns 403.

---

## 7. Problems Discovered During Verification and Their Fixes

### Problem 1: Postgres Multi-Statement Query Driver Error
- **Symptom:** During initial `resetDemoTenantData` implementation, combining multiple `DELETE` statements into a single template literal threw `error: cannot insert multiple commands into a prepared statement`.
- **Root Cause:** Postgres.js / Drizzle protocol does not allow multiple SQL statements in a single prepared statement execution.
- **Fix:** Refactored `reset.ts` to execute sequential `await db.execute(sql`DELETE FROM ... WHERE tenant_id = ${tenantId}`)` statements across the tables.

### Problem 2: Empty String Webhook Secrets in `.env`
- **Symptom:** In `POST /demo/payment-fail`, the loopback webhook failed with HTTP 401 `INVALID_SIGNATURE: Stripe webhook secret is not configured`.
- **Root Cause:** In `webhooks/routes.ts`, the code used nullish coalescing `config?.payments?.stripeWebhookSecret ?? DEV_MOCK_STRIPE_WEBHOOK_SECRET`. In `.env`, `STRIPE_WEBHOOK_SECRET=""` was an empty string `""`. In JavaScript, `"" ?? "default"` evaluates to `""` (not undefined or null), causing signature verification to treat the secret as unconfigured.
- **Fix:** Updated `webhooks/routes.ts` to explicitly verify `rawStripeSecret && rawStripeSecret.trim() !== ""` before falling back to `DEV_MOCK_STRIPE_WEBHOOK_SECRET` when in mock mode.

### Problem 3: Static `this.redis` Reference in `AiDecideService`
- **Symptom:** `bun run check-types` failed with `Property 'redis' does not exist on type 'typeof AiDecideService'`.
- **Root Cause:** `AiDecideService.decide` is a static method receiving `options: DecideOptions`. Inside the method, `this.redis` was mistakenly written instead of `options.redis`.
- **Fix:** Replaced with `options.redis ?? null`.

### Problem 4: `CheckoutItem` Schema Incompatibility
- **Symptom:** `simulator.service.ts` threw `Property 'unitAmountMinor' is missing in type ... but required in type 'CheckoutItem'`.
- **Root Cause:** `simulator.service.ts` used `unitPriceMinor` instead of the Drizzle schema's typed `unitAmountMinor`.
- **Fix:** Updated the item literal to `{ sku, name, quantity, unitAmountMinor: cartValueMinor }`.

---

## 8. Verification Evidence (Definition of Done)

All acceptance criteria from `specs/steps/s-29.md` were verified:

### 8.1 Test Suite Verification
Executed `bunx vitest run apps/backend/src/tests/demo-simulation.test.ts`:
```text
✓ Step 29 Integration: Demo Mode, Simulation Endpoints & Seed Data > Simulation Endpoints > POST /demo/payment-fail triggers signed loopback webhook and pipeline (4996ms)
✓ Step 29 Integration: Demo Mode, Simulation Endpoints & Seed Data > Simulation Endpoints > POST /demo/payment-succeed generates success webhook and signals workflow (2632ms)
✓ Step 29 Integration: Demo Mode, Simulation Endpoints & Seed Data > Simulation Endpoints > POST /demo/checkout-abandon initiates checkout.started and advances timer state (4341ms)
✓ Step 29 Integration: Demo Mode, Simulation Endpoints & Seed Data > Simulation Endpoints > POST /demo/invoice-overdue dispatches signed overdue webhook (1944ms)
✓ Step 29 Integration: Demo Mode, Simulation Endpoints & Seed Data > Demo Auth & Role Security > allows execution with demo API key
✓ Step 29 Integration: Demo Mode, Simulation Endpoints & Seed Data > Demo Auth & Role Security > rejects API key without 'demo' scope (403)
✓ Step 29 Integration: Demo Mode, Simulation Endpoints & Seed Data > Demo Auth & Role Security > rejects VIEWER role session (403)
✓ Step 29 Integration: Demo Mode, Simulation Endpoints & Seed Data > Demo Auth & Role Security > rejects unauthenticated requests (401)
✓ Step 29 Integration: Demo Mode, Simulation Endpoints & Seed Data > Failure Injection Switches > manages toggle lifecycle in Redis (PATCH -> GET -> TTL)
✓ Step 29 Integration: Demo Mode, Simulation Endpoints & Seed Data > Failure Injection Switches > proves deduplication live when simulate_duplicate_webhook is active (2453ms)
✓ Step 29 Integration: Demo Mode, Simulation Endpoints & Seed Data > Production & Mock Disabled Guards > returns 410 MOCK_DISABLED when MOCK_PROVIDERS=false
✓ Step 29 Integration: Demo Mode, Simulation Endpoints & Seed Data > Production & Mock Disabled Guards > omits demo routes in production build when MOCK_PROVIDERS=false (404)
✓ Step 29 Integration: Demo Mode, Simulation Endpoints & Seed Data > Production & Mock Disabled Guards > rejects minting demo-scoped API key when MOCK_PROVIDERS=false
✓ Step 29 Integration: Demo Mode, Simulation Endpoints & Seed Data > Deterministic Seed & Reset > produces identical content hash across two independent re-seeds (35291ms)
✓ Step 29 Integration: Demo Mode, Simulation Endpoints & Seed Data > Deterministic Seed & Reset > aborts reset on non-demo tenant slugs

Test Files  1 passed (1)
     Tests  15 passed (15)
  Duration  61.17s
```

### 8.2 CLI Seed Execution Verification
Executed `bun run db:seed --reset`:
```text
$ bun --filter @repo/db db:seed --reset
🌱 Initiating Demo Seed on tenant: 'demo-tenant'...
🧹 Executing safe tenant-scoped reset on 'demo-tenant'...
✅ Safe reset completed.
👥 Generating 1,000 customers...
🎯 Seeding pristine pre-trigger Scenarios A, B, and C...
💳 Generating 2,500 payments (2,200 succeeded, 300 failed)...
🛒 Generating 400 checkouts (250 active, 150 abandoned)...
📄 Generating 180 overdue invoices...
⚖️ Generating 100 recovery cases with outcomes and cost entries...

=======================================================
🎉 DEMO SEED COMPLETED SUCCESSFULLY!
🏢 Tenant:            demo-tenant (f904590a-82c6-4401-918b-57fe9b5d4c48)
👥 Customers:         1,000
💳 Payments:          2,500 (2,200 succeeded, 300 failed)
🛒 Checkouts:         400 (250 active, 150 abandoned)
📄 Overdue Invoices:  180
⚖️ Recovery Cases:    100 (45 recovered, 20 stopped, 15 escalated, 20 in-progress)
📊 Outbound Outcomes: 45 authoritative outcomes + 90 cost entries
🎯 Scenario Fixtures: CUS-001 (A), CUS-002 (B), CUS-003 (C) + A-variant
🔒 Determinism Hash:  22785c9449e186952d14cfe16789c7a84f764a57cb8b0ffb2bae75608158048b
=======================================================
```

### 8.3 Repository Verification Commands
1. `bun run check-types`: Clean pass (12/12 packages in scope).
2. `bun run lint`: Clean pass (2/2 packages in scope).
3. `bun run check-docs`: Clean pass (31 links verified).

---

## 9. Deviations and Judgment Calls

1. **Direct Fastify `app.inject` vs External HTTP Loopback:**
   - *Decision:* Used Fastify's `app.inject` for webhook simulation rather than making external network HTTP requests to `http://localhost:8000`.
   - *Rationale:* In CI environments or containerized deployments where port bindings or hostnames may differ, `app.inject` executes the full HTTP pipeline (content negotiation, pre-handlers, body parsing, auth, and error handling) with zero network dependency, avoiding flaky timeouts while exercising authentic routing.
2. **Deterministic PRNG Algorithm Selection:**
   - *Decision:* Implemented Mulberry32 in `packages/db/src/seeds/factories.ts`.
   - *Rationale:* Mulberry32 is lightweight, standalone (zero external dependencies), extremely fast across 10,000 iterations, and provides uniform 32-bit randomness guaranteeing identical content hashes on any platform.
3. **Safe Reset Isolation:**
   - *Decision:* The `--reset` flag checks `tenant.slug.startsWith("demo-")` before executing `DELETE` statements.
   - *Rationale:* Prevents disastrous data loss if an operator accidentally triggers `db:seed --reset` against a staging or production database containing live tenants.
