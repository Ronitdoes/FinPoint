# Runbook: CertExpiry (warn — ops hygiene)

**Alert:** `CertExpiry` — `min(cert_expiry_days) < 14` for 1h.
**Severity:** warn · **Owner:** Platform on-call.
**Dashboards:** [Infrastructure](../../infra/grafana/dashboards/infra.json) (TLS expiry panel).
**Reference:** rotation procedure (webhook secrets are separate — see `webhook-secrets-rotation.md`); this runbook contains rotation *references only, no secrets* (CONVENTIONS §12).

## Symptoms

- Public TLS certificate expires in under 14 days; at 0, all provider webhooks (Stripe/Razorpay signature delivery), dashboard users, and API clients hard-fail simultaneously.

## Diagnosis

1. Which host? `cert_expiry_days{host}` — dashboard, API, webhook endpoints may terminate on different certs (LB vs service).
2. Is renewal automated (ACME/cert-manager) and merely failing, or manual? Check the renewal job logs for the last 30 days — a red renewal job is the usual cause, not the calendar.

## Mitigation

- Fix the renewal automation first (permissions, DNS-01 challenge, rate limits); force-renew once green.
- Manual path only if automation is absent: issue → stage → cut over at low-traffic hour → verify every endpoint in `docs/deploy/webhooks.md` (each provider re-handshakes TLS independently).
- Re-verify: `cert_expiry_days > 60` and the alert resolved; record the new expiry date in the ticket.

## Escalation

- Expiry <72h with renewal still failing ⇒ page Platform lead; prepare the manual path and notify Revenue-Ops of a maintenance window.

*Lifecycle: firing → acknowledged → mitigated (new expiry recorded) → postmortem-link only on recurrence (automation must exist after the second firing).*
