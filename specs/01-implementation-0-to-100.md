# AI Revenue Recovery — Implementation 0 to 100

## Goal

Build a working system from an empty repository to a production-style demo where:

1. an event enters the system
2. revenue risk is detected
3. customer context is assembled
4. the LLM produces a structured recommendation
5. the policy engine validates it
6. Temporal executes the approved workflow
7. the system calls a payment/messaging adapter
8. the outcome is persisted
9. the dashboard proves recovered revenue

---

# 0. Final target architecture

```text
                           ┌──────────────────────┐
                           │ Stripe / Razorpay    │
                           │ Checkout / Billing   │
                           │ ERP / CRM            │
                           └──────────┬───────────┘
                                      │
                                      ▼
                           ┌──────────────────────┐
                           │ Fastify Event Gateway│
                           │ auth + validation    │
                           │ idempotency          │
                           └──────────┬───────────┘
                                      │
                                      ▼
                           ┌──────────────────────┐
                           │ Kafka / Redpanda      │
                           └──────────┬───────────┘
                                      │
                   ┌──────────────────┼──────────────────┐
                   ▼                  ▼                  ▼
             Risk Engine       Context Service      Analytics
                   │                  │
                   └────────────┬─────┘
                                ▼
                     ┌─────────────────────┐
                     │ AI Decision Service │
                     └──────────┬──────────┘
                                │
                                ▼
                     ┌─────────────────────┐
                     │ Policy Engine       │
                     └──────────┬──────────┘
                                │
                                ▼
                     ┌─────────────────────┐
                     │ Temporal            │
                     │ Durable Workflows   │
                     └──────────┬──────────┘
                                │
             ┌──────────────────┼──────────────────┐
             ▼                  ▼                  ▼
       Payment Adapter    Messaging Adapter   Human Escalation
             │                  │                  │
             └──────────────────┼──────────────────┘
                                ▼
                     ┌─────────────────────┐
                     │ PostgreSQL          │
                     │ outcomes + audit    │
                     └──────────┬──────────┘
                                ▼
                     ┌─────────────────────┐
                     │ Next.js Dashboard   │
                     └─────────────────────┘
```

---

# 1. 0–5% — Define the domain

Before writing infrastructure, define the business vocabulary.

Core entities:

```text
Customer
Payment
Subscription
Checkout
Invoice
RevenueRisk
RecoveryCase
RecoveryAction
Workflow
Message
PromiseToPay
Policy
AuditLog
RecoveryOutcome
```

The central object is:

```text
RecoveryCase
```

Everything related to one recovery attempt belongs to that case.

### Recovery case state

```text
DETECTED
QUALIFIED
DECISION_PENDING
POLICY_REVIEW
IN_PROGRESS
WAITING
RECOVERED
STOPPED
ESCALATED
FAILED
```

---

# 2. 5–10% — Create repository

Recommended repository:

```text
revenue-recovery/
├── apps/
│   ├── web/
│   └── api/
├── services/
│   ├── ai-decision/
│   ├── risk-engine/
│   └── worker/
├── packages/
│   ├── domain/
│   ├── db/
│   ├── policy/
│   ├── integrations/
│   ├── observability/
│   └── config/
├── infra/
│   ├── docker/
│   └── temporal/
├── docs/
└── README.md
```

For the MVP you may collapse services into the Fastify API + worker process. Split services only when boundaries are clear.

---

# 3. 10–15% — Choose the MVP stack

Use:

```text
Frontend:
Next.js + TypeScript + Tailwind

Backend:
Fastify + TypeScript

Database:
PostgreSQL

ORM:
Drizzle ORM

Cache / locks:
Redis

Workflow:
Temporal

Event streaming:
Redpanda initially

AI:
LLM provider with structured outputs

Payments:
Razorpay and/or Stripe

Messaging:
WhatsApp provider + email provider

Observability:
OpenTelemetry

Local development:
Docker Compose
```

Keep Kafka/Redpanda optional in the earliest local prototype.

---

# 4. 15–20% — Local infrastructure

Create Docker services:

```text
postgres
redis
temporal
temporal-ui
redpanda
```

Example conceptual startup:

```bash
docker compose up -d
```

Add health checks.

Make `.env.example`:

```env
DATABASE_URL=
REDIS_URL=
TEMPORAL_ADDRESS=
REDPANDA_BROKERS=

LLM_API_KEY=

STRIPE_SECRET_KEY=
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=

WHATSAPP_API_KEY=
EMAIL_API_KEY=
```

Never commit real secrets.

---

# 5. 20–25% — PostgreSQL schema

Create migrations for:

```text
customers
payments
payment_attempts
subscriptions

checkouts
checkout_events

invoices
invoice_events

revenue_risks
recovery_cases
recovery_actions
recovery_attempts

workflows
workflow_events

messages
message_deliveries
customer_responses

promises_to_pay

policy_rules
policy_versions

audit_logs
recovery_outcomes
```

Important indexes:

```text
payments(customer_id, created_at)
payments(status, created_at)
invoices(status, due_at)
revenue_risks(status, risk_score)
recovery_cases(status, created_at)
recovery_cases(customer_id)
recovery_actions(case_id, created_at)
audit_logs(case_id, created_at)
```

Use PostgreSQL constraints for invariants wherever possible.

---

# 6. 25–30% — Domain events

Standardize your internal event envelope.

```json
{
  "id": "evt_123",
  "type": "payment.failed",
  "occurred_at": "2026-08-23T10:30:00Z",
  "source": "razorpay",
  "tenant_id": "tenant_123",
  "customer_id": "cus_123",
  "entity_id": "pay_123",
  "payload": {}
}
```

Required properties:

```text
event id
event type
timestamp
tenant
source
entity id
payload
correlation id
```

---

# 7. 30–35% — Event Gateway

Build Fastify endpoints:

```text
POST /webhooks/stripe
POST /webhooks/razorpay

POST /events
POST /events/replay
```

Responsibilities:

```text
1. authenticate webhook
2. validate payload
3. normalize provider event
4. check idempotency
5. store raw event
6. publish internal event
7. return quickly
```

Never run LLM logic inside the webhook request.

---

# 8. 35–40% — Risk Engine v1

Start deterministic.

Example scoring:

```text
base = 0

payment_failed_count >= 1   +20
payment_failed_count >= 2   +20
days_overdue >= 3            +15
amount_high                  +10
customer_active              +10
historical_payment_success   +10
high_checkout_intent         +15

cap score at 100
```

Convert to probability-like score only after defining what it means.

A better implementation is:

```text
risk_score = weighted rules
risk_band:
  LOW
  MEDIUM
  HIGH
  CRITICAL
```

Then later introduce calibrated ML probabilities.

---

# 9. 40–45% — Customer Context Service

Do not pass the full database to the LLM.

Build:

```text
GET /customers/:id/context
```

Return a compact context object:

```json
{
  "customer": {},
  "payment_summary": {},
  "subscription_summary": {},
  "invoice_summary": {},
  "checkout_summary": {},
  "recovery_history": {},
  "communication_history": {},
  "preferences": {}
}
```

The context builder should enforce:

```text
privacy
field allowlists
size limits
freshness rules
tenant isolation
```

---

# 10. 45–50% — AI Decision Service

Create one controlled decision endpoint:

```text
POST /ai/decide
```

Input:

```json
{
  "recovery_case": {},
  "risk": {},
  "customer_context": {}
}
```

Output must conform to a schema.

Example:

```json
{
  "diagnosis": {
    "cause": "insufficient_funds",
    "confidence": 0.91
  },
  "action": {
    "type": "RETRY_PAYMENT",
    "delay_hours": 24
  },
  "secondary_actions": [
    {
      "type": "SEND_WHATSAPP",
      "template": "payment_retry_notice"
    }
  ],
  "stop_conditions": [
    "PAYMENT_SUCCEEDED",
    "OPTED_OUT",
    "MAX_RETRIES"
  ]
}
```

Use structured output / JSON schema.

Do not allow arbitrary tool names.

---

# 11. 50–55% — Policy Engine

Build:

```text
POST /policy/evaluate
```

Input:

```text
case
recommended actions
customer state
policy version
```

Output:

```json
{
  "allowed": true,
  "rejections": [],
  "required_approval": false,
  "effective_actions": []
}
```

Hard rules should be deterministic.

Example:

```text
if customer.opted_out = true
    reject all outbound contact

if retry_count >= 3
    reject payment retry

if discount > max_discount
    reject action

if invoice_amount > approval_threshold
    require human approval

if dispute_open = true
    stop collections automation
```

The LLM never overrides this layer.

---

# 12. 55–60% — Recovery Case orchestration

Create case creation logic:

```text
event
 ↓
find/create recovery case
 ↓
attach risk record
 ↓
load customer context
 ↓
request AI decision
 ↓
policy check
 ↓
start workflow
```

Use idempotency on case creation.

A duplicate webhook must not create duplicate recovery cases.

---

# 13. 60–65% — Temporal workflows

Start with one workflow:

```text
FailedPaymentRecoveryWorkflow
```

Pseudo-flow:

```text
start
 ↓
validate case
 ↓
send optional message
 ↓
wait
 ↓
retry payment
 ↓
check result

SUCCESS → recovered
FAILED  → next step
LIMIT   → stop
RISK    → escalate
```

Activities should be small:

```text
loadCase
checkPolicy
sendWhatsApp
sendEmail
retryPayment
refreshPaymentStatus
recordOutcome
createHumanTask
```

Never put external network calls directly into workflow code.

---

# 14. 65–70% — Integration adapters

Create interfaces:

```ts
interface PaymentProvider {
  retryPayment(input: RetryPaymentInput): Promise<RetryPaymentResult>;
  createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLinkResult>;
  getPaymentStatus(id: string): Promise<PaymentStatus>;
}

interface MessagingProvider {
  sendTemplate(input: SendTemplateInput): Promise<SendResult>;
}
```

Implement:

```text
StripeAdapter
RazorpayAdapter

WhatsAppAdapter
EmailAdapter
```

This prevents provider-specific logic from leaking into orchestration.

---

# 15. 70–75% — Build the three MVP workflows

## Workflow A — Payment failure

```text
payment.failed
 → risk
 → context
 → AI decision
 → policy
 → retry
 → message
 → retry
 → recovered / stopped
```

## Workflow B — Checkout abandonment

```text
checkout.started
 → inactivity timer
 → confirm no purchase
 → risk
 → AI
 → policy
 → message
 → optional incentive
 → purchase / stop
```

## Workflow C — Overdue invoice

```text
invoice.overdue
 → risk
 → customer context
 → AI
 → reminder
 → promise-to-pay
 → follow-up
 → payment / escalation
```

---

# 16. 75–80% — Build dashboard

Pages:

```text
/dashboard
/cases
/cases/[id]
/risk
/recovery
/policies
/audit
/settings
```

Dashboard cards:

```text
Revenue At Risk
Recovered
Recovery Rate
Net Recovered
Active Cases
Escalations
```

Charts:

```text
recovery by day
risk by type
strategy success
recovery by channel
recovery by provider
```

---

# 17. 80–82% — Case timeline

Every recovery case needs an event timeline.

Example:

```text
PAYMENT_FAILED
RISK_CALCULATED
AI_DECISION_CREATED
POLICY_ALLOWED
WORKFLOW_STARTED
WHATSAPP_SENT
PAYMENT_RETRY_STARTED
PAYMENT_SUCCEEDED
RECOVERY_RECORDED
```

This is one of the strongest demo features.

---

# 18. 82–85% — Audit trail

Every sensitive action should generate an audit event.

Store:

```text
timestamp
tenant
case
actor
event
model
model_version
prompt_version
decision
policy_version
action
result
correlation_id
```

Do not store secrets or unnecessary customer data in logs.

---

# 19. 85–87% — Human escalation

Create:

```text
human_tasks
```

Examples:

```text
high_value_invoice
policy approval
customer dispute
legal/compliance review
repeated workflow failure
```

Dashboard action:

```text
Approve
Reject
Pause
Resume
Assign
```

Temporal should wait for the human decision rather than polling.

---

# 20. 87–90% — Observability

Instrument:

```text
HTTP latency
workflow latency
LLM latency
LLM token usage
provider latency
provider failures
policy rejection rate
recovery success rate
```

Use:

```text
OpenTelemetry
Prometheus
Grafana
structured logs
correlation IDs
```

Core traces:

```text
event_id
case_id
workflow_id
decision_id
action_id
```

---

# 21. 90–92% — Failure handling

Test these aggressively:

```text
duplicate webhook
out-of-order event
Stripe timeout
Razorpay timeout
WhatsApp timeout
LLM timeout
LLM malformed response
Redis unavailable
Postgres reconnect
Temporal worker crash
browser refresh
network retry
payment succeeds after workflow retry
customer opts out midway
```

Financial actions must be idempotent.

Example:

```text
idempotency_key =
tenant_id + recovery_case_id + action_type + attempt_number
```

---

# 22. 92–94% — Security

Implement:

```text
tenant isolation
RBAC
API authentication
webhook signature validation
encrypted secrets
least-privilege provider credentials
PII minimization
audit logs
rate limiting
CSRF protections where relevant
```

Roles:

```text
ADMIN
FINANCE
OPERATIONS
SUPPORT
VIEWER
```

---

# 23. 94–96% — Testing

### Unit tests

Test:

```text
risk scoring
policy evaluation
decision schema
state transitions
amount calculations
stop conditions
idempotency
```

### Integration tests

Test:

```text
webhook → DB
webhook → event bus
event → case
case → AI
AI → policy
policy → workflow
workflow → adapter
adapter → outcome
```

### Workflow tests

Temporal workflow tests for:

```text
success
retry
timeout
stop
escalation
duplicate event
provider error
```

### End-to-end demo test

One test should prove:

```text
payment fails
→ recovery case appears
→ AI recommends action
→ policy allows it
→ workflow starts
→ message sent
→ payment succeeds
→ dashboard shows recovered money
```

---

# 24. 96–97% — Seed realistic data

Create:

```text
1,000 customers
2,500 payments
300 failed payments
250 active checkouts
150 abandoned checkouts
180 overdue invoices
100 recovery cases
```

Generate realistic distributions.

Seed cases:

```text
low-risk
medium-risk
high-risk
critical
already recovered
stopped
escalated
```

---

# 25. 97–98% — Analytics correctness

Never compute recovery from dashboard UI state.

Use authoritative outcome records.

Example:

```text
recovered_amount
recovery_cost
recovered_at
baseline_amount
attribution_method
```

Define attribution.

Example:

```text
A recovery is attributed when the related payment occurs within
the workflow's attribution window and matches the recovery case.
```

Document this definition.

---

# 26. 98–99% — Deployment

Suggested deployment:

```text
Vercel
    ↓
Next.js web

AWS / Railway / Render
    ↓
Fastify API
    ↓
Temporal workers
    ↓
PostgreSQL
    ↓
Redis
    ↓
Redpanda/Kafka
```

Use Docker for API and workers.

Set up:

```text
CI
lint
typecheck
unit tests
integration tests
build
migration checks
```

---

# 27. 99–100% — Demo narrative

Your final demo should take 3–5 minutes.

### Scene 1

Show dashboard:

```text
₹12.8L revenue at risk
```

### Scene 2

Trigger:

```text
payment.failed
```

### Scene 3

Open case:

```text
Risk = 86%
```

### Scene 4

Show AI:

```text
Diagnosis:
insufficient funds

Recommendation:
retry in 24h + WhatsApp
```

### Scene 5

Show policy:

```text
ALLOWED
```

### Scene 6

Show Temporal:

```text
WAIT → MESSAGE → RETRY
```

### Scene 7

Simulate successful payment.

### Scene 8

Dashboard changes:

```text
Revenue At Risk: ₹12.8L → ₹12.787L
Recovered: ₹12,999
```

### Scene 9

Open audit trail.

That proves:

```text
Detection
Decision
Governance
Execution
Recovery
Auditability
```

---

# 28. Recommended build order by weeks

## Week 1

```text
repo
Docker
Postgres
Drizzle
domain schema
Fastify
Next.js shell
```

## Week 2

```text
webhook ingestion
event normalization
idempotency
risk engine
recovery cases
```

## Week 3

```text
customer context
LLM decision service
structured outputs
policy engine
```

## Week 4

```text
Temporal
payment adapter
messaging adapter
failed payment workflow
```

## Week 5

```text
checkout abandonment
overdue invoices
promise-to-pay
human escalation
```

## Week 6

```text
dashboard
audit timeline
analytics
observability
```

## Week 7

```text
tests
failure injection
security
seed data
```

## Week 8

```text
deployment
demo polishing
benchmarking
documentation
architecture diagram
```

---

# 29. Definition of done

The MVP is done when this scenario works from start to finish:

```text
1. Provider sends payment.failed
2. Event is authenticated
3. Duplicate event is ignored
4. Internal event is created
5. Risk is calculated
6. Recovery case is created
7. Context is assembled
8. AI returns schema-valid decision
9. Policy validates decision
10. Temporal workflow starts
11. Message is sent
12. Payment retry occurs
13. Provider returns success
14. Outcome is recorded
15. Recovered amount is computed
16. Dashboard reflects it
17. Audit timeline contains every major event
18. System can recover from worker/API restarts
```

---

# 30. What NOT to build initially

Avoid:

```text
multi-agent architecture
fine-tuned LLM
vector database before retrieval is needed
full ML pipeline
voice agent
Kafka cluster complexity
20 third-party providers
complex pricing engine
autonomous discount negotiation
fully autonomous collections
```

Start with a bounded system that proves the financial loop.
