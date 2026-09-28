# Runbook: Webhook Secret Rotation — Abuse-Block Companion (s-30)

> Naming note (patch-02): this file (`webhook-secret-rotation.md`, singular) is the s-30 operations companion covering abuse-block interplay, verification signals, and the ADMIN clear path. The canonical rotation procedure lives in [`webhook-secrets-rotation.md`](./webhook-secrets-rotation.md) (plural). Both files are intentional; do not merge without preserving the signals table below.

Canonical rotation procedure lives in
[`webhook-secrets-rotation.md`](./webhook-secrets-rotation.md) — this page
covers what s-30 added around it: abuse-block interplay, verification
signals, and the ADMIN clear path.

## During rotation: expect signature-failure noise

Deploying a new secret while providers still sign with the old one produces
`401 INVALID_SIGNATURE` responses. Since s-30, repeated failures from one
IP install a **temporary 10-minute block** (`429 IP_BLOCKED`):

- The block threshold is 10 failures/IP/10 min
  (`apps/backend/src/modules/security/ip-block.service.ts`).
- Provider retries from a *different* egress IP are unaffected; retries from
  the *same* IP during the block get 429 and are retried by the provider
  later (Stripe/Razorpay both retry non-2xx), so no data loss — but the
  rotation takes longer.

Prefer the runbook's zero-downtime paths (Stripe dual-signature roll,
Razorpay dual-endpoint migration) so failures stay near zero.

## Verification signals

| Signal | Healthy rotation | Investigate |
|---|---|---|
| `webhook_deliveries_total{status="accepted"}` | steady/increasing | flatline |
| `webhook_deliveries_total{status="invalid_signature"}` | brief spike, decays | sustained > 0 |
| `security_signature_failures_total` | brief spike, decays | sustained > 0 |
| `security_ip_blocks_total` | 0 | > 0 means provider egress got blocked |

## If a provider egress IP gets blocked

1. Confirm the block and its TTL:

   ```text
   GET /admin/ip-blocks   (ADMIN role required)
   ```

2. Finish deploying the correct secret first — clearing early while the
   wrong secret is live just re-trips the block.
3. Clear explicitly (blocks otherwise expire after 10 minutes):

   ```text
   DELETE /admin/ip-blocks/<ip>   (ADMIN role required)
   ```

4. Watch `security_signature_failures_total` return to baseline.

## Emergency revocation

Follow §3 of [`webhook-secrets-rotation.md`](./webhook-secrets-rotation.md)
(revoke endpoint, rotate, audit `events` for fraudulent rows). After
revoking, clear any blocks on your own egress IPs so legitimate retries
flow immediately.
