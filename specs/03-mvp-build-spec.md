# AI Revenue Recovery — MVP Build Specification

## Objective

Build a convincing end-to-end demo for three recovery paths:

1. failed payment
2. checkout abandonment
3. overdue invoice

The MVP must prove:

```text
Detection
Decision
Policy
Execution
Recovery
Audit
Analytics
```

---

# 1. MVP feature matrix

| Feature | MVP |
|---|---|
| Payment webhooks | Yes |
| Razorpay/Stripe adapter | Yes |
| Risk scoring | Rule-based |
| Customer context | Yes |
| LLM decisioning | Yes |
| Structured output | Yes |
| Policy engine | Yes |
| Temporal | Yes |
| WhatsApp | Yes or mocked adapter |
| Email | Yes |
| Checkout abandonment | Yes |
| Overdue invoices | Yes |
| Promise-to-pay | Yes |
| Human escalation | Yes |
| Audit trail | Yes |
| Dashboard | Yes |
| ML scoring | Later |
| Voice | Later |
| Multi-agent | No |
| Advanced experimentation | Later |

---

# 2. Mock mode

The application must run without live payment providers.

Create:

```text
MockPaymentProvider
MockMessagingProvider
```

Simulation endpoints:

```text
POST /demo/payment-fail
POST /demo/payment-succeed
POST /demo/checkout-abandon
POST /demo/invoice-overdue
```

This allows demos without moving real money.

---

# 3. Demo seed scenarios

## Scenario A — High-intent failed payment

```text
customer: CUS-001
amount: ₹12,999
failure: insufficient_funds
previous_successes: 17
previous_failures: 1
```

Expected:

```text
risk = HIGH
action = retry + WhatsApp
policy = ALLOWED
workflow = started
```

## Scenario B — Abandoned high-value checkout

```text
customer: CUS-002
cart: ₹7,999
checkout duration: 4m 12s
```

Expected:

```text
risk = HIGH
action = reminder first
discount = none initially
```

## Scenario C — Enterprise invoice

```text
customer: CUS-003
invoice: ₹4,80,000
days overdue: 7
```

Expected:

```text
risk = HIGH
human approval = required
```

---

# 4. Demo data model

### customers

```text
id
tenant_id
name
email
phone
status
lifetime_value
created_at
```

### payments

```text
id
tenant_id
customer_id
amount
currency
status
provider
provider_payment_id
created_at
```

### recovery_cases

```text
id
tenant_id
customer_id
risk_type
source_entity_id
amount_at_risk
risk_score
status
created_at
updated_at
```

### recovery_actions

```text
id
case_id
type
status
parameters
policy_result
started_at
completed_at
```

### audit_logs

```text
id
tenant_id
case_id
event
actor_type
actor_id
metadata
created_at
```

### recovery_outcomes

```text
id
case_id
payment_id
recovered_amount
recovery_cost
attribution_method
recovered_at
```

---

# 5. MVP decision schema

```json
{
  "type": "object",
  "required": ["diagnosis", "actions", "stop_conditions"],
  "properties": {
    "diagnosis": {
      "type": "object",
      "required": ["cause", "confidence"]
    },
    "actions": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["type"]
      }
    },
    "stop_conditions": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  }
}
```

Allowed actions:

```text
RETRY_PAYMENT
SEND_WHATSAPP
SEND_EMAIL
CREATE_PAYMENT_LINK
OFFER_INCENTIVE
CREATE_HUMAN_TASK
STOP_CASE
```

---

# 6. MVP policy examples

```text
MAX_PAYMENT_RETRIES = 3
MAX_WHATSAPP_PER_7_DAYS = 2
MAX_EMAIL_PER_14_DAYS = 3
MAX_AUTO_DISCOUNT = ₹500
HIGH_VALUE_APPROVAL = ₹100,000
```

Stop immediately when:

```text
payment succeeded
customer opted out
case disputed
policy says stop
retry limit reached
```

---

# 7. Dashboard requirements

## Overview

Show:

```text
Revenue at Risk
Revenue Recovered
Recovery Rate
Recovery Cost
Net Recovered
Active Cases
Escalations
```

## Recovery funnel

```text
At Risk
  ↓
Qualified
  ↓
Contacted
  ↓
Attempted
  ↓
Recovered
```

## Intervention performance

```text
Action              Cases   Success   Recovered
Payment retry       ...
WhatsApp            ...
Email               ...
Payment link        ...
Human escalation    ...
```

## Case detail

Show:

```text
customer
financial obligation
risk
AI decision
policy result
workflow status
actions
customer responses
outcome
audit timeline
```

---

# 8. Acceptance tests

## Payment recovery

```text
Given a failed payment
When the event enters the gateway
Then one recovery case is created
```

```text
Given duplicate webhook
When same event is received again
Then no duplicate case is created
```

```text
Given retry count = 3
When AI recommends another retry
Then policy rejects it
```

```text
Given successful retry
When payment succeeds
Then workflow closes
And outcome records recovered amount
```

## Checkout

```text
Given active checkout
When purchase completes
Then abandonment workflow stops
```

```text
Given abandoned checkout
When threshold passes
Then a recovery case may be created
```

## Invoice

```text
Given high-value overdue invoice
When AI recommends incentive
Then policy requires human approval
```

---

# 9. Failure injection

Create demo/test switches:

```text
SIMULATE_PAYMENT_TIMEOUT=true
SIMULATE_MESSAGE_FAILURE=true
SIMULATE_LLM_FAILURE=true
SIMULATE_DUPLICATE_WEBHOOK=true
```

Use them to prove resilience.

---

# 10. Performance targets for MVP

These are engineering targets, not business guarantees:

```text
Webhook response < 300ms for accepted async event
API p95 < 500ms for normal reads
Policy evaluation < 50ms
Risk calculation < 50ms
LLM decision < 5s typical
No duplicate financial action
100% of sensitive actions auditable
```

Measure actual values rather than claiming them.

---

# 11. Security acceptance criteria

```text
No provider secret in frontend
No raw secret in logs
Webhook signatures validated
Tenant context mandatory
Role checks on admin endpoints
LLM context allowlisted
Outbound actions pass policy
Audit records immutable to normal operators
```

---

# 12. Presentation/demo checklist

Before showing the project:

- [ ] seed realistic data
- [ ] start all infrastructure
- [ ] verify Temporal worker
- [ ] verify dashboard
- [ ] trigger a payment failure
- [ ] show case creation
- [ ] show AI decision
- [ ] show policy result
- [ ] show workflow
- [ ] simulate payment success
- [ ] show recovered amount
- [ ] open audit trail
- [ ] show ROI metric
