# Audit Trail & Timeline Field Contract

This document defines the canonical audit trail metadata keys, case timeline entry shapes, actor conventions, PII boundaries, and immutability guarantees across the AI Revenue Recovery platform (Spec 01 §17, §18; Spec 03 §11; Step 25).

---

## 1. Core Principles & Guarantees

1. **Append-Only Immutability**:
   - `audit_logs`, `case_events`, and `audit_archive` tables are strictly append-only.
   - Database triggers (`BEFORE UPDATE OR DELETE ON ... RAISE EXCEPTION`) prevent modification or deletion even under direct SQL operations.
   - Dedicated database roles enforce structural least-privilege:
     - `app_rw`: `SELECT`, `INSERT` (no `UPDATE`, `DELETE`, `TRUNCATE`).
     - `audit_writer`: `INSERT`, `SELECT` only.

2. **Access Separation**:
   - **Compliance Audit Surface** (`GET /audit`): Strictly `ADMIN` role only. Exposes full metadata with actor attribution for regulatory reviews.
   - **Operational Case Timeline** (`GET /cases/:id/timeline`): `VIEWER+` roles (`VIEWER`, `SUPPORT`, `OPERATIONS`, `FINANCE`, `ADMIN`). Merges `case_events` with linked entities and provides an explainable narrative.

3. **PII and Secret Invariants**:
   - Never store raw secrets (`sk_*`, `whsec_*`, `Bearer`, API keys) in audit or case event metadata.
   - Customer identifiers, payment cards, emails, and phone numbers must be masked at ingestion and presentation edges (`maskEmail`, `maskPhone`, `maskCard`).
   - Automated CI scanner (`pii-scanner.ts`) continuously enforces clean payloads.

---

## 2. Actor Types & Conventions

All audit and timeline entries attribute actions to an actor:

| `actor_type` | Description | Typical `actor_id` |
|---|---|---|
| `SYSTEM` | Core platform automation, cron jobs, event bus | `"system"`, `"orchestrator"`, `"sla-sweeper"` |
| `AI` | LLM decision engines, recommendation services | Model identifier (e.g. `"gpt-4o@2024-08-06"`, `"claude-3-5-sonnet"`) |
| `USER` | Human operators acting via dashboard / API sessions | `user_id` (UUID from `users` table) |
| `CUSTOMER` | Customer responses, inbound webhooks, opt-outs | `customer_id` (UUID from `customers` table) |
| `PROVIDER` | Upstream payment gateways, messaging networks | Provider identifier (e.g. `"stripe"`, `"razorpay"`, `"meta"`) |

---

## 3. Canonical Audit Events (`audit_logs`)

Audit logs capture sensitive domain mutations and state transitions.

### 3.1 Decision & Governance Events

- **`ai.decision.created`**:
  - `case_id`: UUID
  - `actor_type`: `"AI"`
  - `actor_id`: Model name
  - `metadata`:
    ```json
    {
      "model": "gpt-4o",
      "model_version": "2024-08-06",
      "prompt_version": "payment_failure@1",
      "confidence": 0.85,
      "decision": "RETRY_AFTER_DELAY",
      "diagnosis": "Card expired with insufficient balance",
      "cost_paise": 42
    }
    ```

- **`policy.evaluated`**:
  - `case_id`: UUID
  - `actor_type`: `"SYSTEM"`
  - `metadata`:
    ```json
    {
      "policy_version": "pol_v1_live",
      "result": "APPROVED",
      "requires_approval": false,
      "matched_rules_count": 3
    }
    ```

### 3.2 Financial & Provider Events

- **`payment.attempted`**:
  - `case_id`: UUID
  - `actor_type`: `"SYSTEM"`
  - `metadata`:
    ```json
    {
      "gateway": "stripe",
      "attempt_number": 2,
      "amount_minor": 129900,
      "currency": "INR",
      "status": "FAILED",
      "failure_code": "card_declined"
    }
    ```

- **`message.dispatched`**:
  - `case_id`: UUID
  - `actor_type`: `"SYSTEM"`
  - `metadata`:
    ```json
    {
      "channel": "WHATSAPP",
      "template": "payment_reminder_v1",
      "recipient_masked": "+91 98765*****",
      "status": "SENT"
    }
    ```

### 3.3 Human Governance Events

- **`human.decided`**:
  - `case_id`: UUID
  - `actor_type`: `"USER"`
  - `actor_id`: Operator UUID
  - `metadata`:
    ```json
    {
      "task_id": "018f...",
      "task_type": "HIGH_VALUE_APPROVAL",
      "decision": "APPROVED",
      "notes": "Customer confirmed verbal agreement"
    }
    ```

### 3.4 Operational & Lifecycle Events

- **`case.transitioned`**, **`case.paused`**, **`case.resumed`**, **`case.escalated`**, **`case.stopped`**:
  - `case_id`: UUID
  - `actor_type`: `"USER"` | `"SYSTEM"`
  - `metadata`:
    ```json
    {
      "from_status": "IN_PROGRESS",
      "to_status": "STOPPED",
      "reason": "CUSTOMER_REQUESTED"
    }
    ```

---

## 4. Unified Case Timeline (`GET /cases/:id/timeline`)

The timeline API combines `case_events` (primary spine) with enriched relations:

```json
{
  "items": [
    {
      "id": 101,
      "at": "2026-08-28T10:00:00.000Z",
      "type": "PAYMENT_FAILED",
      "eventType": "PAYMENT_FAILED",
      "actor": { "type": "SYSTEM", "id": null },
      "description": "Initial payment failure detected: insufficient_funds",
      "data": {
        "amount": 1499900,
        "currency": "INR",
        "gateway": "razorpay",
        "declineCode": "insufficient_funds"
      },
      "payload": {
        "amount": 1499900,
        "currency": "INR",
        "gateway": "razorpay",
        "declineCode": "insufficient_funds"
      }
    },
    {
      "id": 102,
      "at": "2026-08-28T10:00:05.000Z",
      "type": "AI_DECISION_CREATED",
      "eventType": "AI_DECISION_CREATED",
      "actor": { "type": "AI", "id": "gpt-4o" },
      "description": "AI recovery recommendation generated",
      "data": {
        "diagnosis": "Temporary liquidity shortage, retry after 24h",
        "confidence": 0.88,
        "topAction": "RETRY_PAYMENT",
        "promptVersion": "payment_failure@1",
        "costPaise": 35
      },
      "payload": {
        "diagnosis": "Temporary liquidity shortage, retry after 24h",
        "confidence": 0.88,
        "topAction": "RETRY_PAYMENT",
        "promptVersion": "payment_failure@1",
        "costPaise": 35
      }
    }
  ],
  "nextCursor": "eyJvY2N1cnJlZEF0IjoiMjAyNi0wOC0yOFQxMDowMDowNS4wMDBaIiwiaWQiOjEwMn0"
}
```

---

## 5. Retention & Archiving Policy

1. **Active Window**: All events in `audit_logs` are preserved for 12 months in the hot operational database.
2. **Archival to Cold Storage (copy-only, decided semantic)**:
    - `AuditRetentionJob` scans for records older than the configured threshold (e.g. >12 months).
    - Rows are transactionally copied into `audit_archive` with `archived_at` timestamps.
    - `audit_archive` shares identical immutability protections and DB triggers.
    - **No delete step**: `archiveAuditLogsBatch` copies but never deletes. The
      `prevent_audit_modification()` trigger (`BEFORE UPDATE OR DELETE → RAISE
      EXCEPTION` on `audit_logs`/`case_events`/`audit_archive`) would reject any
      `DELETE`, so retention intentionally keeps both hot and archive copies to
      preserve append-only immutability. The sole privileged bypass is the s-35
      demo-reset hatch (`SET LOCAL app.allow_audit_delete='on'` in
      `packages/db/src/seeds/reset.ts`, transaction-local, never used by
      retention or production code).
