# Runbook: ProviderFailureRate (page — provider incident path)

**Alert:** `ProviderFailureRate` — one `(provider, op)` fails >10% over 15m.
**Severity:** page · **Owner:** Platform on-call (primary) · Integrations owner (secondary).
**Dashboards:** [Operations](../../infra/grafana/dashboards/operations.json) (provider failure rate by provider/op), [AI](../../infra/grafana/dashboards/ai.json) (fallback correlation).
**Logs:** [`docs/LOGGING.md`](../LOGGING.md) query D filtered to `provider.name`.

## Symptoms

- A single integration degrading: `stripe/charge`, `razorpay/charge`, `whatsapp/send`, `email/send`. Financial risk: retries burn decline budgets; messaging risk: contact-cap waste.

## Diagnosis

1. Which `(provider, op)`? `sum by (provider, op) (rate(provider_calls_total{status="error"}[15m])) / sum by (provider, op) (rate(provider_calls_total[15m]))`.
2. Provider status page + our recent config: credential rotation/expiry (`401/403` ⇒ key/secret — rotation runbooks), quota/rate-limit (`429` ⇒ back off, check our send cadence vs caps), upstream outage (5xx across regions ⇒ provider incident).
3. Blast radius in our system: `provider_latency_ms` p95 (hang vs fast-fail), `fallback_total` rising (LLM path unaffected — different provider class), workflow retries climbing.

## Mitigation (provider-incident path)

- Payments: bounded retries already enforce idempotency (`tenant:case:RETRY_PAYMENT:attempt` — no double-charge by construction); on sustained outage, pause affected case cohorts (`POST /cases/:id/pause`, audited) rather than letting retries exhaust decline budgets.
- Messaging: traffic stays under policy caps automatically; on WhatsApp outage, do NOT burst-failover to Email beyond caps — caps are per-channel and absolute.
- Credentials: rotate per `least-privilege-credentials.md`; verify with one canary send before re-enabling.
- Resolve when the provider/op error rate <2% for 30m.

## Escalation

- Upstream SEV (provider status page red) ⇒ notify Revenue-Ops + Finance; consider the degraded-mode banner (see `llm-fallback-rate.md` doctrine for the analogous AI path).
- Suspected credential leak ⇒ emergency revocation + Security notify (CONVENTIONS §12).

*Lifecycle: firing → acknowledged → mitigated → postmortem-link (required).*
