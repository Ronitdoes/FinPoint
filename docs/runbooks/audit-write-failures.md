# Runbook: AuditWriteFailures (page — immutability regression)

**Alert:** `AuditWriteFailures` — any `increase(audit_write_failures_total[15m]) > 0`.
**Severity:** page · **Owner:** Platform on-call (primary) · Backend lead (secondary).
**Dashboards:** [Operations](../../infra/grafana/dashboards/operations.json) (audit write failures panel — must read 0).
**Logs:** [`docs/LOGGING.md`](../LOGGING.md) query D for `audit` errors; canonical contract [`docs/audit-field-contract.md`](../audit-field-contract.md).

## Symptoms

- ANY audit/case-event write failure is a spec 03 §10 breach (100% of sensitive actions auditable). Threshold is zero by design — there is no "acceptable" level.

## Diagnosis

1. Failure class in logs: structural violation (field contract drift — a deploy emitting non-conformant audit rows) vs role violation (app writing with a role lacking `audit_writer`; RLS/grant regression — see ADR-015).
2. Correlate with deploys: which release touched `modules/audit`, repositories writing `audit_logs`/`case_events`, or DB roles/grants (migration changing ownership)?
3. Blast radius: `verifyAuditCoverage` (s-25 checker) — which lifecycle events are missing coverage since the failure started; timeline gaps may need `backfillCaseTimelineGaps` AFTER the writer is fixed.

## Mitigation

- Structural: roll back the emitting deploy (forward-only rollback, `docs/deploy/rollback.md`); fix the field-contract violation; re-verify with the PII/secret redaction scanner before re-deploying.
- Role/grant: restore `audit_writer` grants (least-privilege doc); confirm `prevent_audit_modification` triggers still in place (immutability must survive the repair — never "fix" by weakening triggers).
- Backfill proven gaps with the backfill tool; verify coverage checker green before resolving.

## Escalation

- Any window where sensitive actions went unaudited ⇒ notify Compliance/Finance in addition to the page; the postmortem must quantify the gap (counts + time range) from the coverage checker.

*Lifecycle: firing → acknowledged → mitigated (coverage green) → postmortem-link (required, with gap quantification).*
