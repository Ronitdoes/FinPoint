# Service-Level Objectives — AI Revenue Recovery (s-34)

Initial SLOs for staging (promote to prod at first cutover; thresholds
re-tune from the baselines in `docs/PERFORMANCE.md`). All objectives are
measured in Prometheus; alert names in parentheses.

## 1. Objectives

| # | SLO | Target | Window | Signals | Alert |
|---|---|---|---|---|---|
| 1 | Ingest availability: accepted-async webhook responses served successfully | **99.5%** of deliveries not `error` | 30d rolling | `webhook_deliveries_total{status}` | `WebhookErrorRate` (page at >2%/5m fast-burn) |
| 2 | Journey success: started recovery workflows reach a terminal business outcome (`RECOVERED`/`STOPPED`/approved `/stop`) without `FAILED` | **≥99%** weekly | 7d rolling | `workflow_started_total` vs `workflow_outcome_total{result="FAILED"}` | `WorkflowFailureRate` (page at >1%/15m fast-burn) |
| 3 | Webhook latency: accepted-async responses | p95 **<300ms** | 7d rolling | `webhook_duration_ms` | `P95WebhookLatency` (warn at breach/15m) |
| 4 | Audit completeness: every sensitive action auditable | **100%** (zero write failures) | 30d rolling | `audit_write_failures_total` | `AuditWriteFailures` (page on any increase) |
| 5 | Execution liveness: Temporal pollers present on `recovery-main` | **100%** of minutes | 30d rolling | `temporal_worker_pollers` | `TemporalWorkerPollers` (page at 0 for 5m) |

Slow-burn companions (ticket/warn, same windows): `BusDLQDepth`,
`ProviderFailureRate`, `LLMFallbackRate`, `PolicyRejectionSpike`,
`RecoveredAmountDrop`, `DBPoolSaturation`, hygiene set (`CertExpiry`,
`DiskFills`), meta (`MonitoringPipelineDown`).

## 2. Error-budget policy

- Budgets derive from SLO 1 (0.5% monthly ≈ 3.6h downtime) and SLO 2 (1%
  weekly ≈ 100 min of failed journeys per 10k starts).
- **Burn >2× baseline for 1h** (fast burn, paging alerts above): Robin —
  acknowledge, mitigate per runbook, freeze non-urgent deploys until the
  burn rate returns under 1× for 6h.
- **Burn >1× baseline for 6h** (slow burn, warn alerts): next-business-day
  ticket; feature work continues but the owning team spends ≥50% capacity
  on reliability until the budget recovers.
- **Budget exhausted (>100% consumed in-window): feature freeze** — no
  non-fix deploys to the burning surface until the postmortem lands and the
  alert that caught it is tuned or the underlying cause is fixed. Policy
  changes (`POL-*` rule edits) count as deploys for this purpose.
- Postmortems link from the alert's runbook lifecycle section
  (firing→acknowledged→mitigated→postmortem-link); every page requires one
  within 5 business days.

## 3. Review cadence

SLOs and thresholds re-tune monthly for the first quarter (then quarterly),
using `docs/PERFORMANCE.md` baselines. Staging-first evaluation per s-34
§Reliability: a threshold change ships to staging alerts, soaks one week,
then promotes to prod.
