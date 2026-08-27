# Runbook: Rotating Webhook Signing Secrets

This runbook details the operational procedure for rotating payment provider webhook signing secrets (`STRIPE_WEBHOOK_SECRET` and `RAZORPAY_WEBHOOK_SECRET`) with zero downtime.

---

## 1. Stripe Webhook Secret Rotation (Zero-Downtime)

Stripe supports multiple active signatures in the `Stripe-Signature` header during a rolling transition window.

### Step-by-Step Procedure

1. **Access Stripe Dashboard**:
   - Navigate to **Developers → Webhooks → Endpoints**.
   - Select the target endpoint (`https://<domain>/webhooks/stripe`).

2. **Roll the Signing Secret**:
   - In the **Signing secret** card, click **Roll secret...**.
   - Choose the expiration window for the old secret (e.g., **24 hours**).
   - Stripe will immediately start sending webhook payloads signed with **both** the new `v1` signature and the expiring `v1` signature (`t=...,v1=<new_sig>,v1=<old_sig>`).

3. **Deploy the New Secret**:
   - Copy the new secret string (`whsec_...`).
   - Update `STRIPE_WEBHOOK_SECRET` in your secret manager (e.g., AWS Secrets Manager, Doppler, Kubernetes Secret, or `.env` in staging).
   - Trigger a rolling release of `apps/backend`.

4. **Verify Verification Success**:
   - In Grafana / Prometheus, check the metric `webhook_deliveries_total{provider="STRIPE", status="accepted"}`.
   - Ensure `webhook_deliveries_total{provider="STRIPE", status="invalid_signature"}` remains 0.

5. **Expire Old Secret**:
   - Once deployment is complete and confirmed, the old secret will automatically expire at the configured deadline or can be revoked explicitly from the Stripe dashboard.

---

## 2. Razorpay Webhook Secret Rotation

Razorpay supports single-secret HMAC-SHA256 headers (`x-razorpay-signature`).

### Step-by-Step Procedure

1. **Access Razorpay Dashboard**:
   - Navigate to **Settings → Webhooks**.
   - Select your existing webhook endpoint or create a secondary webhook endpoint pointing to `/webhooks/razorpay`.

2. **Dual-Endpoint / Staged Migration**:
   - *Option A (Zero-Downtime via Duplicate Webhook)*:
     1. Add a second webhook endpoint in Razorpay dashboard with the **new** secret.
     2. Update `RAZORPAY_WEBHOOK_SECRET` on `apps/backend`.
     3. Remove the old webhook endpoint in Razorpay. (The Event Gateway's idempotency layer `events_duplicate_total` will gracefully drop any overlapping duplicate deliveries during the transition).
   - *Option B (In-place Secret Update)*:
     1. Generate a new secret in Razorpay.
     2. Update `RAZORPAY_WEBHOOK_SECRET` and restart the backend.
     3. Razorpay retries non-2xx failed deliveries automatically with exponential backoff (within 24 hours), ensuring zero permanent data loss during a brief rolling restart.

3. **Verify Verification Success**:
   - Check `webhook_deliveries_total{provider="RAZORPAY", status="accepted"}`.
   - Verify that incoming payments and subscriptions are properly populated.

---

## 3. Emergency Secret Revocation (Compromised Key)

If a webhook secret is exposed or leaked:

1. **Immediate Revocation**:
   - Immediately delete the compromised webhook endpoint in Stripe/Razorpay dashboard to halt untrusted traffic.
2. **Rotate Secrets**:
   - Create a fresh webhook secret in the provider dashboard.
   - Update environment variables and deploy immediately.
3. **Audit Ingested Events**:
   - Query recent events in PostgreSQL to audit any fraudulent records:
     ```sql
     SELECT id, source, external_event_id, type, received_at
     FROM events
     WHERE received_at >= NOW() - INTERVAL '2 hours'
     ORDER BY received_at DESC;
     ```
   - If fraudulent events are detected, mark them as `FAILED` and initiate incident response.
