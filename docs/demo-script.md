# AI Revenue Recovery — 9-Scene Live Demo Script

This document details the exact 3–5 minute, 9-scene demonstration script defined in **Spec 01 §27** and verified against the running application in Step 29.

---

## Pre-Demo Setup & Environment Readiness

Ensure all infrastructure and background services are healthy:

```bash
# 1. Start all infrastructure containers
bun run infra:up

# 2. Apply database migrations
bun run db:migrate

# 3. Seed realistic spec volumes (1,000 customers, 2,500 payments, 400 checkouts, 180 invoices, 100 cases, Scenarios A/B/C)
bun run db:seed --reset

# 4. (Optional) Start development servers if not already running via Docker:
bun run dev
```

### Access URLs & Credentials

- **Frontend Dashboard**: [http://localhost:3000](http://localhost:3000)
- **Backend API**: [http://localhost:4000](http://localhost:4000)
- **Temporal UI**: [http://localhost:8080](http://localhost:8080)
- **Login Email**: `ops@example.com` (or `admin@example.com`)
- **Password**: `Admin12345!@#`

---

## 9-Scene Walkthrough Narrative

```
Scene 1: System Baseline Dashboard  (₹12.8L at risk)
   ↓
Scene 2: Inbound Failure Trigger    (POST /demo/payment-fail)
   ↓
Scene 3: Real-Time Case Creation    (Risk = 86%, Band = HIGH)
   ↓
Scene 4: Autonomous AI Diagnosis    (Cause: insufficient_funds)
   ↓
Scene 5: Policy Governance Check    (Verdict: ALLOWED)
   ↓
Scene 6: Resilient Orchestration    (WAIT → MESSAGE → RETRY)
   ↓
Scene 7: Payment Success Loopback   (POST /demo/payment-succeed)
   ↓
Scene 8: Authoritative ROI Realized (Revenue at Risk drops, ₹12,999 Recovered)
   ↓
Scene 9: Immutable Audit Trail      (Complete chronological proof)
```

---

### Scene 1: System Baseline Dashboard

**Goal**: Establish system credibility, showing baseline revenue metrics and realistic workload.

1. Navigate to the dashboard at [http://localhost:3000](http://localhost:3000) and sign in.
2. Note the overview metrics:
   - **Revenue at Risk**: Approximately `₹12.80L` across active open cases.
   - **Active Cases**: 20 cases currently in progress.
   - **Recovered Revenue**: Initial baseline from historical recovered cases.
3. Show the recovery funnel and risk distribution (LOW, MEDIUM, HIGH, CRITICAL).

---

### Scene 2: Inbound Payment Failure Trigger

**Goal**: Demonstrate that failures enter through the real event gateway via HMAC-signed webhook loopback.

Trigger Scenario A (CUS-001, ₹12,999 high-intent customer):

```bash
curl -X POST http://localhost:4000/demo/payment-fail \
  -H "Content-Type: application/json" \
  -H "Cookie: rr_session=<YOUR_SESSION_COOKIE>" \
  -d '{
    "customer_ref": "CUS-001",
    "amount_minor": 1299900,
    "provider": "STRIPE"
  }'
```

**What happened behind the scenes**:
1. Simulator constructed a real Stripe `payment_intent.payment_failed` payload.
2. Computed cryptographic HMAC-SHA256 signature using the configured secret.
3. Posted to `/webhooks/stripe`. The gateway verified the signature, normalized the payload, idempotently recorded the event, and published it to `revenue-events.v1`.

---

### Scene 3: Real-Time Case Creation & Risk Scoring

**Goal**: Show deterministic risk scoring and automated case qualification.

1. On the dashboard [http://localhost:3000/cases](http://localhost:3000/cases), observe the newly opened case for customer `CUS-001`.
2. Click into the case to open the Case Detail view (`/cases/[id]`):
   - **Risk Score**: `86 / 100` (`HIGH` risk band).
   - **Risk Factors**: High previous success rate (17 previous successes), customer lifetime value, and soft decline reason (`insufficient_funds`).

---

### Scene 4: Autonomous AI Diagnosis & Decisioning

**Goal**: Prove the LLM generates structured, bounded interventions with fallback safety.

1. Inspect the **AI Decision** card in the case timeline:
   - **Diagnosis**: `insufficient_funds` (high confidence).
   - **Recommendation**: Send payment reminder via WhatsApp, wait 24h, and retry payment.
   - **Stop Conditions**: Payment succeeds, customer opts out, or retry limit reached.

---

### Scene 5: Policy Governance Check

**Goal**: Prove that autonomous decisions are strictly governed before execution.

1. Inspect the **Policy Verdict** card on the case:
   - **Verdict**: `ALLOWED`
   - **Rules Evaluated**:
     - `POL-RETRIES`: Retry count (1 / 3) — OK.
     - `POL-COOLDOWN`: Frequency limit per 7 days — OK.
     - `POL-APPROVAL`: ₹12,999 is below high-value threshold (`₹1,00,000`) — Autonomous execution allowed.

---

### Scene 6: Temporal Workflow Execution

**Goal**: Demonstrate durable, stateful execution that survives failures and restarts.

1. Open the Temporal Web UI at [http://localhost:8080](http://localhost:8080).
2. Look up workflow ID `recover:<caseId>`:
   - Status: `RUNNING`
   - Current activity: `sendWhatsAppMessage` completed → `WAITING_FOR_PAYMENT`.
3. In mock mode, the messaging provider records the template message without sending external spam.

---

### Scene 7: Payment Success Simulation

**Goal**: Simulate payment recovery and demonstrate instant workflow signaling.

Capture the `payment_id` from the case details, then trigger success:

```bash
curl -X POST http://localhost:4000/demo/payment-succeed \
  -H "Content-Type: application/json" \
  -H "Cookie: rr_session=<YOUR_SESSION_COOKIE>" \
  -d '{
    "payment_id": "<PAYMENT_ID>"
  }'
```

**What happened behind the scenes**:
1. Simulator generated a signed Stripe `payment_intent.succeeded` webhook.
2. Gateway ingested the webhook and published `payment.succeeded`.
3. `PaymentSuccessSignalBridge` caught the event and signaled `external-payment-succeeded` to the Temporal workflow.
4. The workflow closed immediately and recorded authoritative recovery outcome.

---

### Scene 8: Dashboard ROI & State Update

**Goal**: Verify that recovery updates the authoritative financial ledger and dashboard.

1. Refresh or return to [http://localhost:3000](http://localhost:3000):
   - **Revenue at Risk**: Decreased from `₹12.80L` to `₹12.787L` (reflecting the resolved obligation).
   - **Recovered Revenue**: Increased by exactly `₹12,999`.
   - **Net Recovered**: Reflects `₹12,999` minus recorded processing and messaging costs.
2. Case status transitioned to `RECOVERED`.

---

### Scene 9: Immutable Audit Trail Inspection

**Goal**: Prove end-to-end governance, compliance, and non-repudiation.

1. In the Case Detail view, open the **Audit Trail** tab.
2. Trace the sequence of append-only events:
   - `PAYMENT_FAILED_DETECTED` (actor: SYSTEM / Gateway)
   - `RISK_EVALUATED` (score: 86, band: HIGH)
   - `AI_DECISION_PROPOSED` (diagnosis: insufficient_funds)
   - `POLICY_EVALUATED` (allowed: true)
   - `MESSAGE_DISPATCHED` (channel: WHATSAPP)
   - `PAYMENT_RECOVERED` (amount: ₹12,999)
   - `CASE_CLOSED` (status: RECOVERED)

This conclusively proves the core pillars:
**Detection → Decision → Governance → Execution → Recovery → Auditability**.
