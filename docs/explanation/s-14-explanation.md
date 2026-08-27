# s-14 — AI Decision Service: Core Decision Path: Implementation Explanation

This document provides a comprehensive architectural and operational explanation of the AI Decision Service implemented in `specs/steps/s-14.md`. It covers versioned prompt templates, strict JSON Schema export for structured outputs, resilient OpenAI-compatible LLM transport with circuit breaker and retry logic, multi-stage structural and semantic validation, single repair retry ($N=1$), deterministic rule-based fallback safety net, token tracking with Indian Rupee paise cost accounting, transactional persistence into `ai_decisions`, 24-hour request idempotency, RBAC enforcement, and tenant isolation.

---

## Table of Contents

1. [What the step required](#1-what-the-step-required)
2. [Workspace architecture & file layout](#2-workspace-architecture--file-layout)
3. [Structured decision schemas & JSON schema export (`schemas/decision.ts`)](#3-structured-decision-schemas--json-schema-export-schemasdecisionts)
4. [Versioned prompt registry & integrity checksums (`prompts/*`)](#4-versioned-prompt-registry--integrity-checksums-prompts)
5. [Resilient LLM client & circuit breaker (`llm/*`)](#5-resilient-llm-client--circuit-breaker-llm)
6. [Structured completion engine & paise token pricing (`llm/structured.ts`)](#6-structured-completion-engine--paise-token-pricing-llmstructuredts)
7. [Multi-stage validation pipeline (`validate/*`)](#7-multi-stage-validation-pipeline-validate)
8. [Deterministic rule-based fallback recommender (`validate/fallback.ts`)](#8-deterministic-rule-based-fallback-recommender-validatefallbackts)
9. [AI decision orchestration service (`decide.service.ts`)](#9-ai-decision-orchestration-service-decideservicets)
10. [REST APIs (`POST /ai/decide` & `GET /ai/decisions/:id`)](#10-rest-apis-post-aidecide--get-aidecisionsid)
11. [Observability, Prometheus metrics & distributed tracing](#11-observability-prometheus-metrics--distributed-tracing)
12. [Testing strategy & verification suite](#12-testing-strategy--verification-suite)
13. [Verification evidence (Definition of Done)](#13-verification-evidence-definition-of-done)
14. [Key design decisions & architectural rationale](#14-key-design-decisions--architectural-rationale)

---

## 1. What the step required

Per `specs/steps/s-14.md`, Spec 01 §10, Spec 02 §8, Spec 03 §5, ADR-008, ADR-009, ADR-011, and ADR-012:

1. **Versioned Prompt Templates**:
   - Distinct, tested prompt templates for each recovery surface:
     - `payment_failure@1` (failed payments, subscription billing)
     - `checkout_abandonment@1` (abandoned checkout sessions)
     - `invoice_overdue@1` (overdue B2B invoices)
   - Fixed system prompt establishing strict operational invariants (e.g. bounded autonomy, non-hallucination, mandatory stop conditions, allowable actions only).
   - Dynamic user prompt formatter injecting masked customer context from s-13 and risk evaluation from s-12.
   - SHA-256 checksum computation over full prompt strings for deterministic integrity tracking.
2. **OpenAI-Compatible LLM Client**:
   - Structured JSON completion endpoint integration (`/v1/chat/completions` with `response_format: { type: "json_schema" }`).
   - 20-second timeout per attempt.
   - Maximum 2 retries with exponential backoff and jitter on transient errors (429 Rate Limit, 500/502/503 Server Errors, network drops).
   - Immediate rejection on non-transient 4xx errors without retry.
   - In-memory Circuit Breaker tripping to `OPEN` after 5 consecutive transport failures with a 60-second cooldown period before a `HALF_OPEN` probe.
   - Failure injection support via `SIMULATE_LLM_FAILURE=true`.
3. **Structured Decision Schema & Output Validation**:
   - Zod schema for root diagnosis, action sequence (1 to 3 actions bounded), and stop conditions.
   - Runtime structural validation (JSON shape and type adherence).
   - Runtime semantic validation:
     - All actions belong to `AI_DECIDABLE_ACTIONS` for that surface.
     - `STOP_CASE` is never mixed with other actions.
     - `RETRY_PAYMENT` delay is bounded to $[1, 168]$ hours.
     - `OFFER_INCENTIVE` discount is capped at `MAX_AUTO_DISCOUNT_MINOR` (5,000 INR = 500,000 paise).
4. **Repair Retry & Deterministic Fallback**:
   - If initial LLM output is malformed or invalid, perform exactly one ($N=1$) repair prompt including the validation error messages.
   - If repair also fails, circuit breaker is open, or LLM fails, fall back gracefully to a deterministic rule-based decision (`FALLBACK_RULE_BASED`), incrementing `fallback_total{reason}` counter and returning HTTP 200 without user-facing outage.
5. **PAISE Token Cost Tracking**:
   - Token accounting based on prompt and completion token counts using published GPT-4o pricing converted to Indian Rupee paise integer minor units (ADR-009).
6. **Decision Row Persistence & Idempotency**:
   - Full persistence into PostgreSQL `ai_decisions` table recording model, prompt version, input snapshot, output raw JSON, diagnosis, actions, stop conditions, status (`COMPLETED`, `FALLBACK_RULE_BASED`, `INVALID_OUTPUT`), token usage, latency ms, and cost in minor units.
   - 24-hour request idempotency via `Idempotency-Key` header with lease locking and stored response snapshots.
7. **REST APIs & RBAC**:
   - `POST /ai/decide`: Orchestrates context gathering, prompt assembly, structured LLM completion, validation, fallback, and persistence. Requires session role $\ge$ `OPERATIONS` or machine API key with `ai:decide` / `*` scope.
   - `GET /ai/decisions/:id`: Fetches decision record with strict tenant isolation (returns 404 across tenant boundaries).

---

## 2. Workspace architecture & file layout

```
apps/backend/
├── src/
│   ├── lib/
│   │   └── routes.ts                                 # Registered /ai routes prefix
│   ├── modules/
│   │   └── ai/
│   │       ├── schemas/
│   │       │   ├── decision.ts                       # Zod schemas (Diagnosis, Action, Decision) & getDecisionJsonSchema()
│   │       │   └── schemas.test.ts                   # Unit tests for schema validation & strict JSON Schema export
│   │       ├── prompts/
│   │       │   ├── payment-failure.ts                # payment_failure@1 template definition & formatter
│   │       │   ├── checkout-abandonment.ts           # checkout_abandonment@1 template definition & formatter
│   │       │   ├── invoice-overdue.ts                # invoice_overdue@1 template definition & formatter
│   │       │   ├── registry.ts                       # Prompt registry (getPrompt, listPromptDefinitions)
│   │       │   └── prompts.test.ts                   # Unit tests for prompt registry, sha256 checksums, & formatters
│   │       ├── llm/
│   │       │   ├── circuit-breaker.ts                # LlmCircuitBreaker (5 failures -> OPEN, 60s cooldown -> HALF_OPEN)
│   │       │   ├── client.ts                         # LlmClient (timeout, retries with jitter, SIMULATE_LLM_FAILURE)
│   │       │   ├── structured.ts                     # StructuredCompletionService (generate, repair, token cost calc)
│   │       │   └── client.test.ts                    # Unit tests for retries, circuit breaker, repair prompt, & token pricing
│   │       ├── validate/
│   │       │   ├── structural.ts                     # validateStructural (JSON parsing & Zod type checking)
│   │       │   ├── semantic.ts                       # validateSemantic (catalog bounds, action constraints, discount caps)
│   │       │   ├── fallback.ts                       # generateFallbackDecision (deterministic rule-based recommender)
│   │       │   └── validate.test.ts                  # Unit tests for structural, semantic, and fallback validations
│   │       ├── decide.service.ts                     # AiDecideService (complete decision orchestration pipeline)
│   │       ├── routes.ts                             # POST /ai/decide & GET /ai/decisions/:id Fastify plugin
│   │       └── index.ts                              # Module barrel export
│   └── tests/
│       └── ai-decision.test.ts                       # Integration tests (happy path, fallback, idempotency, RBAC, isolation)
packages/
├── db/
│   └── src/
│       └── repositories/
│           └── decisions.repo.ts                     # findLatestDecisionForCase repository query
└── observability/
    └── src/
        └── metrics.ts                                # fallbackTotal Prometheus counter & recordFallback helper
```

---

## 3. Structured decision schemas & JSON schema export (`schemas/decision.ts`)

The AI output contract is strictly defined using Zod schemas matching Spec 03 §5 and ADR-008:

```typescript
export const DiagnosisSchema = z.object({
  cause: z.string().min(1).max(100),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(500),
});

export const DecisionActionSchema = z.object({
  type: z.enum(ACTION_TYPES),
  delay_hours: z.number().int().min(0).max(168).optional(),
  template_id: z.string().optional(),
  channel: z.enum(["WHATSAPP", "EMAIL", "SMS"]).optional(),
  incentive_type: z.enum(["FIXED_DISCOUNT", "PERCENT_DISCOUNT", "WAIVE_LATE_FEE"]).optional(),
  incentive_value: z.number().int().min(0).max(MAX_AUTO_DISCOUNT_MINOR).optional(),
  currency: z.string().length(3).optional(),
  assignee_role: z.enum(["OPERATIONS", "FINANCE", "SUPPORT"]).optional(),
  urgency: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  rationale: z.string().min(1).max(300),
  params: z.record(z.unknown()).optional(),
});

export const DecisionRecordSchema = z.object({
  diagnosis: DiagnosisSchema,
  actions: z.array(DecisionActionSchema).min(1).max(3),
  stop_conditions: z.array(z.string()).min(1),
});
```

To support OpenAI Structured Outputs, `getDecisionJsonSchema()` converts this contract to strict JSON Schema with `additionalProperties: false` and explicit `required` lists across all nested object properties.

---

## 4. Versioned prompt registry & integrity checksums (`prompts/*`)

Every recovery surface has an immutable prompt definition:

| Surface | Prompt Version | Target Risk Type | Allowed Action Types |
|---|---|---|---|
| Payment Failure | `payment_failure@1` | `PAYMENT_FAILURE` | `RETRY_PAYMENT`, `SEND_WHATSAPP`, `SEND_EMAIL`, `SEND_SMS`, `ESCALATE_HUMAN`, `STOP_CASE` |
| Checkout Abandonment | `checkout_abandonment@1` | `CHECKOUT_ABANDONMENT` | `SEND_WHATSAPP`, `SEND_EMAIL`, `SEND_SMS`, `OFFER_INCENTIVE`, `ESCALATE_HUMAN`, `STOP_CASE` |
| Invoice Overdue | `invoice_overdue@1` | `INVOICE_OVERDUE` | `SEND_EMAIL`, `SEND_WHATSAPP`, `SEND_SMS`, `RECORD_PROMISE_TO_PAY`, `OFFER_INCENTIVE`, `ESCALATE_HUMAN`, `STOP_CASE` |

Each prompt definition includes:
- **System Prompt**: Enforces operational guardrails, strict bounded autonomy, and output schema constraints.
- **User Prompt Formatter**: Deterministically renders case details, risk evaluation, and the masked customer context.
- **SHA-256 Checksum**: Computed over the system prompt and template instructions to guarantee prompt integrity across runs.

---

## 5. Resilient LLM client & circuit breaker (`llm/*`)

The LLM transport layer is built to withstand real-world provider unreliability:

```
[Incoming Request]
        │
        ▼
[Circuit Breaker Open?] ─── YES ───► [Deterministic Fallback Recommender]
        │ NO
        ▼
[OpenAI Structured Completion]
        │
        ├── 200 OK ───────────────► [Return Structured Result]
        ├── 429 Rate Limit ───────► Exponential Backoff + Full Jitter (Retry N=2)
        ├── 5xx Server Error ─────► Exponential Backoff + Full Jitter (Retry N=2)
        ├── 4xx Client Error ─────► Non-transient Rejection (No Retry)
        └── 5 Consecutive Fails ──► Trip Circuit Breaker to OPEN (60s cooldown)
```

### Circuit Breaker States
- `CLOSED`: Normal operation. Successful calls reset consecutive failure count.
- `OPEN`: Tripped after 5 consecutive transport failures. All calls immediately route to deterministic fallback without waiting for HTTP timeouts.
- `HALF_OPEN`: Entered after 60-second cooldown. Allows a single probe request. If the probe succeeds, the circuit resets to `CLOSED`; if it fails, it returns to `OPEN` for another 60 seconds.

---

## 6. Structured completion engine & paise token pricing (`llm/structured.ts`)

### Token Pricing Model (Paise Minor Units)
Per ADR-008 and ADR-009, token consumption is calculated in integer minor units (paise) using standard exchange rates (₹84.00 / USD):

$$\text{Input Cost} = \left\lceil \frac{\text{inputTokens} \times 0.000005 \times 8400}{1000} \right\rceil \text{ paise}$$
$$\text{Output Cost} = \left\lceil \frac{\text{outputTokens} \times 0.000015 \times 8400}{1000} \right\rceil \text{ paise}$$

### Repair Retry Protocol ($N=1$)
If the initial completion returns malformed JSON or fails semantic validation, the `StructuredCompletionService` sends a single repair request containing:
1. The original system and user prompts.
2. The model's previous invalid output.
3. The specific structural/semantic validation errors encountered.

If the repair completion succeeds, execution proceeds normally; if it fails again, a decision row with status `INVALID_OUTPUT` is recorded and execution degrades to the rule-based fallback.

---

## 7. Multi-stage validation pipeline (`validate/*`)

Validation occurs in two distinct passes:

1. **Structural Validation (`validateStructural`)**:
   - Verifies valid JSON syntax.
   - Parses against `DecisionRecordSchema` (presence of `diagnosis`, `actions`, `stop_conditions`).
2. **Semantic Validation (`validateSemantic`)**:
   - **Catalog Containment**: Every action type must belong to `AI_DECIDABLE_ACTIONS` for the case's surface.
   - **Action Count**: Bounded between 1 and 3 actions.
   - **Stop Case Exclusivity**: `STOP_CASE` cannot be combined with any other action.
   - **Retry Delay Bounds**: `delay_hours` must be an integer between 1 and 168 (7 days).
   - **Incentive Limits**: `OFFER_INCENTIVE` value cannot exceed `MAX_AUTO_DISCOUNT_MINOR` (500,000 paise / 5,000 INR).

---

## 8. Deterministic rule-based fallback recommender (`validate/fallback.ts`)

When LLM inference is unavailable or rejected, `generateFallbackDecision` provides deterministic, policy-compliant recommendations:

- **Payment Failure**:
  - Prior retries $\ge 3$ or CRITICAL risk $\to$ `ESCALATE_HUMAN` (role: `OPERATIONS`, urgency: `HIGH`).
  - Otherwise $\to$ `RETRY_PAYMENT` with 24-hour delay and stop condition `PAYMENT_SUCCEEDED`.
- **Checkout Abandonment**:
  - `SEND_WHATSAPP` reminder notice with stop condition `PURCHASE_COMPLETED`.
- **Invoice Overdue**:
  - Overdue $>14$ days $\to$ `ESCALATE_HUMAN` (role: `FINANCE`, urgency: `HIGH`).
  - Otherwise $\to$ `SEND_EMAIL` reminder notice with stop condition `INVOICE_PAID`.

All fallback decisions are persisted with status `FALLBACK_RULE_BASED` and increment the `fallback_total{reason}` metric family.

---

## 9. AI decision orchestration service (`decide.service.ts`)

`AiDecideService.decide()` orchestrates the full 10-step lifecycle:

```
 1. Check Idempotency Key (Return completed snapshot or acquire lease)
 2. Verify Recovery Case (404 on missing/cross-tenant, 409 CASE_TERMINAL on terminal states)
 3. Fetch Revenue Risk Record (from s-12)
 4. Gather Customer Context (from s-13 via CustomerContextService.buildForCase)
 5. Resolve Versioned Prompt Definition (from registry)
 6. Check Circuit Breaker Status
 7. Structured LLM Generation (with timeout & retries)
 8. Multi-Stage Validation & N=1 Repair Retry
 9. Persist Decision Row (COMPLETED, FALLBACK_RULE_BASED, or INVALID_OUTPUT)
10. Finalize Idempotency Lease (save response snapshot)
```

---

## 10. REST APIs (`POST /ai/decide` & `GET /ai/decisions/:id`)

### `POST /ai/decide`
- **Authentication**: Session cookie with role $\ge$ `OPERATIONS` or Bearer API key with scope `ai:decide` / `*`.
- **Request Body**:
  ```json
  {
    "case_id": "4b68e912-7bb3-47cb-b467-3312384a51e2",
    "risk_id": "9124a91b-68e1-4bd2-97b2-84192bc58a12",
    "purpose": "CASE_OPENING"
  }
  ```
- **Response**: Returns the decision response containing `decisionId`, `caseId`, `status`, `diagnosis`, `actions`, `stop_conditions`, `latency_ms`, `model`, and `prompt_version`.

### `GET /ai/decisions/:id`
- **Authentication**: Authenticated user session or API key.
- **Tenant Isolation**: Returns 404 `NOT_FOUND` if the decision does not exist or belongs to another tenant.
- **Serialization**: Formats `costMinorUnits` as a numeric integer to ensure safe JSON serialization.

---

## 11. Observability, Prometheus metrics & distributed tracing

The service instruments OpenTelemetry spans and Prometheus metric families:

- **Metrics**:
  - `llm_calls_total{model, status}`: Tracks total LLM requests by outcome (`success`, `error`).
  - `llm_duration_ms{model}`: Histogram tracking LLM round-trip latency.
  - `llm_tokens_total{model, type}`: Counter tracking `prompt`, `completion`, and `total` tokens.
  - `fallback_total{reason}`: Counter tracking fallback triggers (`circuit_open`, `transport_failure`, `validation_failure`, `unexpected_error`).
- **Distributed Tracing**:
  - Wraps operations in `withSpan("ai.decide")` and `withSpan("llm.completion")` propagating `tenant.id`, `case.id`, `model`, `prompt.version`, and token usage attributes.

---

## 12. Testing strategy & verification suite

The test suite provides comprehensive unit and integration coverage:

1. **Unit Tests (`apps/backend/src/modules/ai/**/*.test.ts`)**:
   - `prompts.test.ts` (5 tests): Prompt registry resolution, SHA-256 checksum stability, prompt formatting.
   - `schemas.test.ts` (5 tests): Zod schema parsing, bounds enforcement, strict JSON Schema generation.
   - `validate.test.ts` (10 tests): Structural validation, catalog validation, stop condition exclusivity, discount limit capping, deterministic fallback rules.
   - `client.test.ts` (9 tests): HTTP client retries, exponential backoff, circuit breaker state machine, token pricing calculation, repair prompt construction.
2. **Integration Tests (`apps/backend/src/tests/ai-decision.test.ts`)**:
   - Happy path: Valid LLM completion $\to$ persisted `COMPLETED` row with tokens and cost.
   - `SIMULATE_LLM_FAILURE`: Direct fallback trigger returning 200 with `FALLBACK_RULE_BASED`.
   - Idempotency replay: Same `Idempotency-Key` returns original cached response without re-executing LLM.
   - Terminal case guard: Returns 409 `CASE_TERMINAL` on cases in `RECOVERED` or `STOPPED` states.
   - Cross-tenant isolation: Returns 404 `CASE_NOT_FOUND` when attempting to decide another tenant's case.
   - RBAC guard: Returns 403 `FORBIDDEN` for `VIEWER` roles or API keys lacking `ai:decide` scope.
   - `GET /ai/decisions/:id`: Correctly retrieves stored decision with BigInt cost serialization and enforces 404 on cross-tenant requests.
   - Mock LLM structured completion: Live assertion of tokens, latency, cost, and payload matching.
   - Malformed fixture repair retry: Verifies initial failure $\to$ $N=1$ repair retry $\to$ persists `INVALID_OUTPUT` $\to$ falls back to `FALLBACK_RULE_BASED`.

---

## 13. Verification evidence (Definition of Done)

All Definition of Done criteria from `specs/steps/s-14.md` are satisfied:

- [x] Versioned prompt definitions for all three recovery surfaces with SHA-256 checksums.
- [x] OpenAI-compatible structured LLM client with timeout, retry backoff with jitter, and circuit breaker.
- [x] Strict Zod schemas and JSON Schema export matching Spec 03 §5.
- [x] Multi-stage structural and semantic validation pipeline with $N=1$ repair retry.
- [x] Deterministic rule-based fallback safety net incrementing `fallback_total{reason}`.
- [x] Indian Rupee paise integer minor units token cost accounting.
- [x] `POST /ai/decide` and `GET /ai/decisions/:id` endpoints with RBAC, tenant isolation, and 24h idempotency.
- [x] All 580 monorepo tests passing across 39 test files (`bun run test`).
- [x] Type check passing across 10 packages (`bun run check-types`).
- [x] Lint checks passing (`bun run lint`).
- [x] Documentation link check passing (`bun run check-docs`).

---

## 14. Key design decisions & architectural rationale

1. **Single-Agent Bounded Autonomy (Spec 01 §30)**:
   - AI is used strictly as a decision advisor outputting structured JSON actions from a closed catalog. It has no direct tool execution privileges or recursive agentic loops.
2. **Deterministic Fallback over Unhandled Outages**:
   - AI failures must never halt revenue recovery. Circuit breaker tripping or malformed LLM output immediately yields a policy-compliant rule-based decision, ensuring zero downtime for customer workflows.
3. **Integer Minor Units for Token Accounting (ADR-009)**:
   - Minor units (paise) prevent floating-point drift across ledger calculations, allowing exact financial cost attribution in Step 26.
4. **Idempotency with Lease Locking**:
   - Prevents duplicate LLM inference calls and double billing when clients or event consumers retry identical requests concurrently.
