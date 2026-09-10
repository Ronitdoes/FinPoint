# Cron inventory — jobs, schedules, idempotency (s-33)

Every recurring job in the platform: what it does, where it runs, how often,
why a missed or doubled tick is harmless, and how to tell it ran. Schedules
are the same in every environment (intervals tunable via env); staging and
prod run them in-process as deployed, with the platform-scheduler mapping as
the HA alternative.

Code: API jobs in `apps/backend/src/jobs/` (registry) + `scheduler.ts`
(overlap-guarded runner); worker reconciler in
`services/worker/src/cron/` (`reconciler.ts` + `scheduler.ts`).
Master toggle + intervals: `CRON_*` in `@repo/config`
(`packages/config/src/env.ts`, `api.ts`).

---

## 1. Inventory table

| Job | Owner process | Default schedule (env) | What it does | Idempotency / overlap |
|---|---|---|---|---|
| `executing-sweeper` | API (`jobs/`, 5-min) | 5 min (fixed) | Reconciles `EXECUTING` rows stuck by crash windows via provider status query — never blind re-execution (s-31) | Status-query guarded; tick skipped while a pass is in flight |
| `attribution-sweeper` | API | hourly (`ATTRIBUTION_SWEEP_INTERVAL_MS=3600000`) | Attributes closed/stopped cases without outcomes via the 4 strict conditions → `ATTRIBUTION_WINDOW` outcomes (s-26) | `recordOutcome` no-ops when already recorded; overlap-guarded |
| `cost-completeness` | API | daily (`COST_AUDIT_INTERVAL_MS=86400000`) | Audits executed actions for missing cost entries, remediates messaging gaps at unit prices (s-26) | Remediation keyed per action; overlap-guarded |
| invoice reconciler + PTP expiry | worker (`WorkerCronScheduler` → `DailyReconciler`) | daily (`RECONCILE_INTERVAL_MS=86400000`) | Emits `invoice.overdue` for orphaned OVERDUE invoices (missed-webhook safety net); marks overdue promises `HONORED`/`EXPIRED` + escalates (s-24) | Orphan query excludes invoiced-with-case; PTP transitions guarded; per-tenant failures logged, pass continues; overlap-guarded |
| `audit-retention` (stub) | API | monthly (`RETENTION_SWEEP_INTERVAL_MS=30d`) | Archives audit rows older than `retentionMonths` (default 12) into cold storage (s-25) | Batched archival; dry-run supported; overlap-guarded |
| `kpi-snapshot` | API | 5 min (`KPI_SNAPSHOT_INTERVAL_MS=300000`) | Re-reads analytics views per tenant, refreshes `kpi_*` gauges + pushes to pushgateway with `tenant=<cohort>` (s-34, ADR-016) | Read-only aggregation; PUT replaces series; per-tenant failures logged, pass continues; overlap-guarded |
| `infra-sampler` | API | 60 s (`INFRA_SAMPLER_INTERVAL_MS=60000`) | Samples DB pool, bus DLQ depth, Temporal pollers, approval depth/age into SLI gauges (s-34) | Gauges only (no writes); every probe failure-isolated; overlap-guarded |

Runner semantics (both processes): a tick that fires while the previous
pass runs is SKIPPED with a warn log (never parallel); tick failures are
caught, logged, and the schedule continues; timers are `unref`'d so jobs
never hold shutdown open. Worker drain on SIGTERM stops the scheduler first,
then the Temporal poller.

## 2. Observability per job

- Structured logs per pass (`cron tick completed` with result counts;
  worker: `worker-cron reconciler pass completed` with
  `{ tenants, orphanedInvoicesEmitted, expiredPromisesResolved }`).
- Metrics: attribution matches increment the attribution counter
  (`recordAttributionSweeperMatch`); cost gaps increment the gap counter
  (`recordCostEntryGap`) — both in `@repo/observability`, scraped via
  `GET /metrics`. s-34 alerting: `BusDLQDepth` covers consumer health;
  `MonitoringPipelineDown` covers scrape-target loss; `RecoveredAmountDrop`
  covers KPI-snapshot staleness via the pushgateway series.
- Absence alert: no successful pass log within 2× interval =
  page (kpi-snapshot staleness additionally trips `RecoveredAmountDrop`;
  sampler death trips `TemporalWorkerPollers`/`MonitoringPipelineDown`).

## 3. Platform-scheduler alternative (HA)

In-process is the default (zero new infrastructure). If an environment
prefers platform scheduling (K8s CronJob / Railway cron / Temporal
Schedules calling-admin endpoint), the mapping is 1:1 — each row above
becomes one scheduled trigger invoking the same job class with the same
interval, and `CRON_ENABLED=false` is set on the long-lived processes so
passes never double-run. Never run both modes in one environment.

## 4. Verification

- Unit: `apps/backend/src/jobs/scheduler.test.ts` (tick cadence, overlap
  skip, failure-keeps-schedule, stop) and
  `services/worker/src/cron/scheduler.test.ts` (aggregation, per-tenant
  error continuation, cadence/stop) — both green in CI `unit`/`integration`.
- Live: after any deploy, logs must show each job's `registered` line at
  boot and one completed pass per interval; the staging smoke runbook
  includes a log check for the hourly attribution pass.
