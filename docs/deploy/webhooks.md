# Webhook configuration runbook — per env, per provider (s-33)

Registers the provider → platform callback surface so signed webhooks reach
a verified endpoint in every environment. Signature verification precedes
any processing (CONVENTIONS §12); tenant context is resolved per request;
repeated verification failures trip the s-30 IP block (10 failures / 10min
→ 10min `429 IP_BLOCKED`).

Code: `apps/backend/src/modules/webhooks/routes.ts` (Stripe/Razorpay),
`apps/backend/src/modules/messaging/webhooks/` (WhatsApp/Email).
Rotation procedure (reused here, not duplicated):
[`../runbooks/webhook-secrets-rotation.md`](../runbooks/webhook-secrets-rotation.md)
(+ [`../runbooks/webhook-secret-rotation.md`](../runbooks/webhook-secret-rotation.md)),
least-privilege credential scoping:
[`../runbooks/least-privilege-credentials.md`](../runbooks/least-privilege-credentials.md).

---

## 1. Endpoint inventory

All paths hang under `/webhooks` (mounted by the route registry). Replace
`<BASE>` with the env base URL (`http://localhost:4000` local,
`https://api-staging.<domain>` staging, `https://api.<domain>` production).

| Provider | Method/path | Purpose | Secret env var | Notes |
|---|---|---|---|---|
| Stripe | `POST <BASE>/webhooks/stripe` | payment / subscription / invoice / checkout events | `STRIPE_WEBHOOK_SECRET` (`whsec_…`) | ±5m timestamp tolerance; raw-body HMAC; `tenant_id` query override for connect-style routing |
| Razorpay | `POST <BASE>/webhooks/razorpay` | payment / subscription / invoice events | `RAZORPAY_WEBHOOK_SECRET` | raw-body HMAC; same `tenant_id` override |
| WhatsApp (Meta) | `GET <BASE>/webhooks/whatsapp` (verify handshake) + `POST <BASE>/webhooks/whatsapp` | delivery receipts, inbound replies (`STOP` → auto opt-out + `customer.opted_out` event) | `WHATSAPP_VERIFY_SECRET` (handshake) + `WHATSAPP_API_KEY` (HMAC-SHA256 signature) | constant-time compare; receipts update the delivery ledger |
| Email provider | `POST <BASE>/webhooks/email` | bounces / complaints / deliveries | `EMAIL_WEBHOOK_SECRET` | status → ledger transitions |

Rate limits (s-30, per-class): payment webhooks `600/min/IP`; provider
status callbacks `30/min/key`. All webhook routes are unauthenticated by
design (provider-signed) and MUST stay behind signature verification —
never add session/API-key auth to these paths.

## 2. Registration per environment

### Local

No registration needed. Drive callbacks with the simulator
(`POST /demo/payment-fail` etc. dispatch signed loopbacks to the local
`/webhooks/*` endpoints) or replay captured fixtures with
`POST /events/replay` (role ≥ OPERATIONS, audited).

### Staging (real TEST-mode providers, signed traffic)

1. Create one TEST-mode webhook endpoint per provider pointing at the
   staging `<BASE>` paths above (Stripe Dashboard → Developers → Webhooks;
   Razorpay Dashboard → Settings → Webhooks; Meta App → WhatsApp →
   Configuration; email provider → webhooks page). Subscribe ONLY to the
   events the normalizer matrix handles (payment / subscription / invoice /
   checkout / message-status) — unmapped types store as `UNMAPPED` by design
   but add noise.
2. Store each signing secret in the platform secret store (NOT in the image,
   NOT in git) under the exact env names in the table; redeploy so the
   pre-deploy migrate + app roll picks them up.
3. Verify with a TEST-mode event per provider: expect `200 ACCEPTED` (or
   `DUPLICATE` on replay), a row in `events`, and the downstream
   `risk.calculated` → case chain in staging logs. Then verify abuse
   handling once: a forged signature must return `401 INVALID_SIGNATURE`
   (and count toward the IP-block budget — use a throwaway egress IP).
4. Register the staging URLs in the provider dashboards as the ONLY
   endpoints for the staging TEST credentials (never mix staging URLs with
   production credentials).

### Production (LIVE providers)

Same four steps with LIVE credentials and the production `<BASE>`, plus:

- Cutover is a config change (secret values), not a code deploy: rotate
  TEST → LIVE secrets in the store, redeploy the same immutable tag, run
  the smoke script, then send one live `payment_intent.succeeded`-class
  probe (e.g. a ₹1 test charge) and confirm `ACCEPTED` + outcome attribution.
- Keep the staging endpoints registered: staging remains the permanent
  webhook-receiving drill target for rotation rehearsals.

## 3. Secret rotation (per provider, any env)

1. Generate the new secret in the provider dashboard WITHOUT deleting the
   old one (all four providers support overlapping secrets / grace).
2. Add the new value to the platform secret store alongside the old; the
   verifier accepts either during the overlap (see rotation runbooks above
   for the dual-secret window mechanics per provider).
3. Redeploy (same tag is fine — secrets inject at runtime), confirm signed
   traffic verifies against the new secret in logs/metrics.
4. Remove the old secret from the provider + store. If verification fails
   mid-rotation, the old secret still verifies — roll the STORE value back,
   never the code.
5. Record the rotation (date, provider, env, operator) in the secret
   manager's audit trail; compromise-driven rotations additionally follow
   the s-30 incident runbook (`docs/SECURITY-CHECKLIST.md` row 10).
