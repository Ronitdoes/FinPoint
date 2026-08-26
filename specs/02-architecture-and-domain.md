# AI Revenue Recovery — Architecture, Domain Model & Workflows

## 1. Architectural contract

```text
AI = recommendation + interpretation
Policy = permission
Temporal = execution + durability
PostgreSQL = source of truth
Event bus = asynchronous propagation
Adapters = provider-specific execution
Dashboard = observation
```

No component should silently take responsibilities that belong to another layer.

---

# 2. Services

## Event Gateway

Responsibilities:

- receive provider webhooks
- authenticate requests
- normalize external events
- enforce idempotency
- publish internal events

Does not:

- call LLMs
- run long workflows
- send customer messages

---

## Risk Engine

Responsibilities:

- detect financial risk
- calculate deterministic score
- identify risk type
- set severity
- create/update risk records

Does not:

- send customer messages
- issue discounts
- bypass policy

---

## Customer Context Service

Responsibilities:

- aggregate approved customer context
- summarize history
- enforce field allowlists
- protect tenant boundaries

Does not:

- decide actions

---

## AI Decision Service

Responsibilities:

- diagnose likely cause
- rank approved intervention types
- generate customer-safe content where allowed
- produce structured output

Does not:

- directly call Stripe/Razorpay
- directly message customers
- bypass policy

---

## Policy Engine

Responsibilities:

- enforce hard limits
- approve/reject action
- require human approval
- enforce contact frequency
- enforce stop conditions

Should be deterministic for hard rules.

---

## Workflow Engine

Temporal owns:

- timers
- retries
- durable state
- compensation
- human waits
- workflow lifecycle

---

## Integration Layer

Provider adapters:

```text
Payment
Messaging
CRM
ERP
Telephony
```

Each adapter has explicit interfaces and idempotency.

---

# 3. Canonical recovery case

```json
{
  "id": "RC-123",
  "tenant_id": "TENANT-1",
  "customer_id": "CUS-123",
  "risk_type": "PAYMENT_FAILURE",
  "source_entity_id": "PAY-99",
  "amount_at_risk": 12999,
  "currency": "INR",
  "risk_score": 0.86,
  "status": "IN_PROGRESS",
  "opened_at": "2026-08-23T10:00:00Z"
}
```

The case links:

```text
risk
decision
policy evaluation
workflow
actions
messages
outcomes
audit events
```

---

# 4. State machine

```text
DETECTED
   ↓
QUALIFIED
   ↓
DECISION_PENDING
   ↓
POLICY_REVIEW
   ├── REJECTED → STOPPED
   ├── APPROVAL_REQUIRED → ESCALATED
   └── ALLOWED
         ↓
    IN_PROGRESS
         ├── WAITING
         ├── RECOVERED
         ├── STOPPED
         └── ESCALATED
```

Every transition should be explicit and auditable.

---

# 5. Event taxonomy

## Payment

```text
payment.created
payment.pending
payment.failed
payment.succeeded
payment.refunded
payment.disputed
```

## Checkout

```text
checkout.started
checkout.item_added
checkout.payment_started
checkout.abandoned
checkout.completed
```

## Subscription

```text
subscription.created
subscription.payment_failed
subscription.renewed
subscription.cancelled
```

## Invoice

```text
invoice.created
invoice.due
invoice.overdue
invoice.paid
invoice.disputed
```

## Customer

```text
customer.replied
customer.opted_out
customer.payment_method_changed
customer_promised_to_pay
customer_payment_received
```

---

# 6. Action catalog

Use an allowlisted catalog:

```text
RETRY_PAYMENT
CREATE_PAYMENT_LINK
SEND_EMAIL
SEND_WHATSAPP
SEND_SMS
OFFER_INCENTIVE
REQUEST_PAYMENT_METHOD_UPDATE
CREATE_PROMISE_TO_PAY
CREATE_HUMAN_TASK
PAUSE_CASE
STOP_CASE
```

The AI should select from this catalog.

---

# 7. Policy examples

```text
Policy: max payment retries
condition: retry_count >= 3
action: RETRY_PAYMENT
result: REJECT
```

```text
Policy: no outbound after opt-out
condition: opted_out = true
action: SEND_EMAIL
result: REJECT
```

```text
Policy: high-value approval
condition: amount_at_risk > 100000
action: OFFER_INCENTIVE
result: REQUIRE_APPROVAL
```

---

# 8. Recovery cost model

Track:

```text
LLM cost
messaging cost
payment processing cost
discount cost
human handling cost
provider cost
```

Then:

```text
net_recovered =
recovered_amount
- recovery_cost
```

And:

```text
recovery_roi =
net_recovered / recovery_cost
```

---

# 9. Attribution model

Do not simply count any payment after a message as recovered.

Each outcome should include:

```text
case_id
payment_id
amount
recovered_at
attribution_window
attribution_method
```

Possible MVP attribution:

```text
A payment is attributed to a case if:

1. it is linked to the same customer and financial obligation
2. it occurs after workflow initiation
3. it occurs within configured attribution window
4. no later competing recovery case owns the obligation
```

---

# 10. Example payment-recovery workflow

```text
Event
 ↓
Case
 ↓
Risk
 ↓
Context
 ↓
AI recommendation
 ↓
Policy
 ↓
Temporal
 ↓
Optional WhatsApp
 ↓
Wait 24h
 ↓
Retry
 ↓
Refresh status
 ├── SUCCESS → Outcome → Close
 ├── FAILED  → next action
 └── UNKNOWN → retry provider status check
```

---

# 11. Example checkout workflow

```text
checkout.started
 ↓
wait 30 min
 ↓
check checkout state
 ├── completed → stop
 └── still abandoned
        ↓
      risk
        ↓
      AI
        ↓
     policy
        ↓
   reminder
        ↓
   wait
        ↓
 check purchase
 ├── purchased → recovered
 └── not purchased
        ↓
 optional incentive
        ↓
 wait
        ↓
 stop
```

---

# 12. Example overdue invoice workflow

```text
invoice.overdue
 ↓
risk classification
 ↓
customer context
 ↓
AI intervention
 ↓
policy
 ↓
reminder
 ↓
wait
 ↓
customer response
 ├── payment → close
 ├── promise → promise workflow
 ├── dispute → human escalation
 └── no response → next step
```

---

# 13. Suggested API surface

## Public/provider-facing

```text
POST /webhooks/stripe
POST /webhooks/razorpay
```

## Internal event APIs

```text
POST /events
POST /events/replay
```

## Cases

```text
GET /cases
GET /cases/:id
POST /cases/:id/pause
POST /cases/:id/resume
POST /cases/:id/escalate
```

## Policy

```text
POST /policy/evaluate
GET /policies
POST /policies
```

## AI

```text
POST /ai/decide
```

## Analytics

```text
GET /analytics/summary
GET /analytics/recovery
GET /analytics/interventions
```

---

# 14. Security boundaries

```text
Provider Webhook
    ↓
Gateway authentication

API user
    ↓
RBAC

AI
    ↓
Only receives allowlisted context

AI action
    ↓
Policy engine

Provider credentials
    ↓
Adapter only

Audit logs
    ↓
Append-oriented, restricted access
```

---

# 15. Tenant isolation

Every business table should carry:

```text
tenant_id
```

At minimum:

```text
customers
payments
subscriptions
checkouts
invoices
recovery_cases
recovery_actions
messages
policies
audit_logs
```

Application queries should always scope by tenant.

For a mature version, consider PostgreSQL Row Level Security.

---

# 16. Repository layering

Recommended code organization:

```text
apps/api
  routes/
  controllers/
  middleware/

packages/domain
  entities/
  enums/
  state-machines/

packages/db
  schema/
  repositories/
  migrations/

packages/policy
  evaluator/
  rules/

packages/integrations
  payments/
  messaging/

services/ai-decision
  prompts/
  schemas/
  decision/

services/worker
  workflows/
  activities/
```

Keep domain logic separate from frameworks.
