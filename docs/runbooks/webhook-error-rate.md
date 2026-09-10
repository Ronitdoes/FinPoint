# Runbook: WebhookErrorRate (page)

**Alert:** `WebhookErrorRate` — error share of webhook deliveries >2% over 5m.
**Severity:** page · **Owner:** Platform on-call (primary) · Backend lead (secondary).
**Dashboards:** [Operations](../../infra/grafana/dashboards/operations.json) (ingest rate by provider/status, error share).
**Logs:** [`docs/LOGGING.md`](../LOGGING.md) queries D (errors) filtered to the failing provider.

## Symptoms

- Paging alert fires; `sum(rate(webhook_deliveries_total{status=~"error|invalid_signature"}[5m])) / sum(rate(webhook_deliveries_total[5m])) > 0.02`.
- Possibly: provider dashboard shows delivery retries; ingest availability SLO (99.5%, [`docs/SLO.md`](../SLO.md) §1) burning.

## Diagnosis

1. Split by provider and status: `sum by (provider, status) (rate(webhook_deliveries_total[5m]))`. `invalid_signature` spike ⇒ §3a; `error` spike ⇒ §3b.
2. Correlate with deploys: did a release touch `modules/webhooks`, normalizers, or secrets in the last hour? (`GET /version` sha vs deploy log.)
3. Check `security_signature_failures_total{provider}` and `security_ip_blocks_total`: a signature-abuse burst trips IP blocks (s-30) which then 429s legitimate traffic — distinguish attack from rotation accident via source-IP spread in logs (query D + `provider`).
4. Trace one failing delivery: pick an `external_event_id` from logs, run LOGGING.md query A with its `correlation_id`.

## Mitigation

- **3a (signatures):** suspect secret rotation accident — complete/rollback rotation per `docs/runbooks/webhook-secrets-rotation.md`; clear wrongful IP blocks via the ADMIN clear API (s-30) only after the secret is correct.
- **3b (errors):** scale/restart API replicas; if a single tenant floods malformed payloads, rate-limit class `webhooks` holds (600/IP) — do NOT block the provider IP range (kills all ingest).
- Verify recovery: error share <0.5% for 15m, alert resolved.

## Escalation

- No recovery in 30m, or all providers failing simultaneously ⇒ page Backend lead; treat as SEV-1 (ingest halted = revenue blind).
- Suspected credential compromise ⇒ emergency revocation path in `webhook-secrets-rotation.md` §3 + notify Security.

*Lifecycle: firing → acknowledged (this page) → mitigated (note resolution + sha) → postmortem-link (required for every page, ≤5 business days).*
