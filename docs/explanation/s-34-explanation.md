# s-34 — Monitoring, Alerting & Operations Runbooks: Implementation Explanation

This document explains, in complete depth, everything that was done to
implement `specs/steps/s-34.md`: production observability as code
(Prometheus + Grafana + Alertmanager + Loki), the 14-alert rule set with a
runbook behind every alert, the KPI snapshot and SLI sampler jobs, the
measured performance table, SLOs, and the nightly perf gate.

---

## Table of contents

1. [What the step required](#1-what-the-step-required)
2. [Metrics gap closure (`@repo/observability`)](#2-metrics-gap-closure-reposervability)
3. [Prometheus + Alertmanager configs](#3-prometheus--alertmanager-configs)
4. [Grafana dashboards as code + compose wiring](#4-grafana-dashboards-as-code--compose-wiring)
5. [KPI snapshot + infra sampler jobs](#5-kpi-snapshot--infra-sampler-jobs)
6. [Runbooks, SLOs, logging, ADR-016](#6-runbooks-slos-logging-adr-016)
7. [Load scripts, gate script, nightly workflow](#7-load-scripts-gate-script-nightly-workflow)
8. [Performance measurement story (incl. two artifacts caught)](#8-performance-measurement-story-incl-two-artifacts-caught)
9. [Tests + degraded-mode banner](#9-tests--degraded-mode-banner)
10. [Verification evidence (Definition of Done)](#10-verification-evidence-definition-of-done)
11. [Deviations and judgment calls](#11-deviations-and-judgment-calls)

---

## 1. What the step required

Step s-34 turns the s-08 instrumentation into **watched, actionable
signals with human procedures**: four provisioned Grafana dashboards, a
Prometheus rule set derived from spec 01 §20 metrics and spec 03 §10
targets (every alert naming a runbook), structured-log aggregation
conventions with case-tracing queries, measured performance numbers vs all
six MVP targets, initial SLOs with an error-budget policy, and a nightly
load gate. The dashboard-data decision (pushgateway vs postgres_exporter)
is recorded as ADR-016.

### Definition of Done checklist (from `specs/steps/s-34.md`)

- Four dashboards live w/ real staging data
- All alerts routed successfully incl. tested paging path for top incidents
- 12+ runbooks reviewed (no TBD owners)
- PERFORMANCE.md populated with MEASURED numbers vs all six targets
- Load gate running nightly; baseline archived

Repo-side deliverables are complete and verified below. The three items
requiring a live staging account (staging-data dashboards, live paging
delivery, live firing drill) are operator steps at first deploy — the
firing-drill runbook (`docs/runbooks/firing-drill.md`) holds the exact
procedure plus the evidence table, and the local executable equivalent
(`monitoring-check` + unit drill tests) runs in CI on every push.

---

## 2. Metrics gap closure (`@repo/observability`)

`s-08` emitted ~15 metric families; the s-34 alerts and dashboards needed
gauges that never existed. Appended as sections 21–26 of
`packages/observability/src/metrics.ts` (additive only — no existing
instrument touched):

| New instrument | Backs |
|---|---|
| `bus_dlq_depth`, `bus_consumer_lag_seconds` (+ setters) | BusDLQDepth alert; Operations panels |
| `db_pool_used/max/saturation_ratio` (+ `setDbPoolStats`) | DBPoolSaturation alert; Infra panels |
| `temporal_worker_pollers`, `temporal_activity_slots_available` | TemporalWorkerPollers page; Infra panels |
| `approval_oldest_age_seconds` (+ setter) | AI approval depth/age panels |
| `kpi_*` (6 gauges) + `KpiSnapshot` + `setKpiSnapshot` | Executive dashboard; RecoveredAmountDrop alert |
| `cert_expiry_days`, `disk_free_ratio`, `redis_memory_ratio` (+ setters) | Hygiene alerts; Infra panels |

Label discipline (CONVENTIONS §12, audited by `monitoring-check` §5):
KPI series carry only `tenant=staging|prod|local` (cohort, never UUID);
no gauge anywhere carries email/phone/case/contact PII.

---

## 3. Prometheus + Alertmanager configs

`infra/prometheus/` (new directory):

- **`prometheus.yml`** — scrape jobs `arr-backend` (`GET /metrics`),
  `pushgateway` (KPI snapshots, `honor_labels`), `node`/`redis`/`postgres`
  (exporters), self-scrape `prometheus` (meta-monitoring). Header documents
  the `/metrics` network-restriction control (private scrape network; the
  s-30 residual risk it closes) and the no-PII label rule.
- **`rules.yml`** — 14 alerts in 6 groups (`arr-ingest`, `arr-pipeline`,
  `arr-providers`, `arr-ai-policy`, `arr-data`, `arr-hygiene`, `arr-meta`),
  each with `severity` (page|ticket|warn), `summary`, `description`,
  `runbook_url`, and `dashboard_url`. The 13 step-listed alerts map 1:1
  (CertExpiry + DiskFills as the hygiene set) plus `MonitoringPipelineDown`
  (`up{job} == 0`) for monitoring-the-monitor. Thresholds encode the step
  text exactly (2%, 1%, 10%, 30%, 3×-baseline with 0.05 rps floor, 50%
  7-day drop, 300ms, 80%, ==0, >0, 14d, <10% free).
- **`alertmanager.yml`** — page → staging paging-drill receiver (until the
  drill log records three clean top-3 deliveries, then the prod receiver is
  swapped via env), ticket → ticket-queue + `#revenue-ops`, warn → slack;
  plus an inhibit rule (pipeline-down suppresses warn noise). No secrets —
  receiver URLs are environment-shaped placeholders documented as
  secret-manager values.

Two expression details worth recording: `BusDLQDepth` has two arms
(`bus_dlq_depth` gauge for the in-process driver + `increase(bus_dlq_total)`
for Redpanda, where depth reads come from topic offsets); `clamp_min(…, 0.001)`
denominators keep quiet services from divide-by-zero paging.

---

## 4. Grafana dashboards as code + compose wiring

`infra/grafana/dashboards/{executive,operations,ai,infra}.json` (new),
each with fixed `uid` (`arr-executive` etc., referenced by alert
`dashboard_url`s), UTC timezone, and panels built only from exported
metrics:

- **Executive** (ADR-016): six `kpi_*` stat panels + recovered-vs-7d-average
  timeseries (the RecoveredAmountDrop source) + outcomes-by-method.
- **Operations**: webhook rate/latency/error-share, DLQ depth + lag,
  workflow starts vs outcomes, case funnel, provider failure rate, policy
  rejection rate, audit-failure stat (must read 0).
- **AI**: LLM latency p50/p95, token rate by kind/model, call rate by
  status, fallback rate + fallbacks-by-reason (circuit-open share is the
  circuit-state proxy — no separate breaker metric exists), approval depth
  + oldest age, policy evaluations by result.
- **Infra**: HTTP error-budget burn, HTTP p95 by route, pool
  saturation/used-vs-max, Redis memory, pollers/activity slots, cert
  expiry, disk free, targets-down count.

Provisioning fix: `dashboards.yaml` pointed at
`/etc/grafana/provisioning/dashboards`, which collides with the mounted
provisioning tree — repointed to `/var/lib/grafana/dashboards` with
matching compose mounts. Compose gained `prometheus`, `pushgateway`,
`alertmanager`, `grafana` (anonymous view **disabled**, dev-only admin
creds), `loki` (new `infra/loki/loki-config.yml`), and the three
exporters (`node/redis/postgres`) so a fresh `infra:up` shows **zero**
down targets. Verified live: 6/6 targets `up`, 14/14 rules loaded,
all containers healthy.

---

## 5. KPI snapshot + infra sampler jobs

Two new in-process cron jobs (registered in `apps/backend/src/jobs/`,
scheduled in `server.ts` for every non-test env, added to the
`docs/deploy/crons.md` inventory):

- **`kpi-snapshot.ts`** (`KpiSnapshotJob`, 5m): per-tenant
  `getAnalyticsSummary` (the exact function behind `GET /analytics/summary`
  — numbers identical to the dashboard API by construction), summed into
  one cohort, written to `kpi_*` gauges **and** PUT to the pushgateway.
  Pure helpers (`buildKpiSnapshot`, `accumulateKpiSnapshots`,
  `formatKpiPushgatewayBody`, `pushKpiSnapshot` with 5s abort) are unit
  tested; per-tenant and push failures degrade to gauges-only with warn
  logs, never aborting the pass.
- **`infra-sampler.ts`** (`InfraSampler`, 60s): four failure-isolated
  probes — pg pool introspection across driver shapes (`probeDbPoolFromDriver`,
  null when unrecognized), true DLQ depth from `getDlqMessages()` on the
  in-process bus, Temporal pollers via real `DescribeTaskQueue`
  (**any** observation failure reports 0 — an unobservable queue pages,
  the runbook disambiguates server-down vs worker-gone), and approval
  depth/head-of-line age across tenants (bounded pages).
- **Config** (`@repo/config`, additive): new `monitoringSchema`
  (`PUSHGATEWAY_URL?`, `MONITORING_COHORT=staging`,
  `KPI_SNAPSHOT_INTERVAL_MS=5m`, `INFRA_SAMPLER_INTERVAL_MS=60s`) surfaced
  as frozen `ServerConfig.monitoring`; `.env.example` + compose backend env
  (`PUSHGATEWAY_URL`, `MONITORING_COHORT=local`) updated.

---

## 6. Runbooks, SLOs, logging, ADR-016

- **14 runbooks** (`docs/runbooks/*.md`, one per alert) + **`firing-drill.md`**
  (top-3 page drill procedure, safety rules, evidence log with staging rows
  pending first deploy). Every runbook follows symptoms → dashboard links →
  diagnosis (numbered, with PromQL/log queries) → mitigation → escalation
  with a **named role owner** (no TBD anywhere — enforced by the gate).
- **`docs/SLO.md`**: five SLOs (ingest 99.5%, journey ≥99% weekly, webhook
  p95 <300ms, audit 100%, pollers 100% of minutes) + error-budget policy
  (2×/1h freeze deploys, 1×/6h reliability capacity, exhaustion = feature
  freeze incl. policy edits) + monthly re-tune cadence.
- **`docs/LOGGING.md`**: pipeline (pino → Promtail → Loki → Grafana;
  local Loki already in compose), correlation-key preservation, redaction
  posture, and six saved LogQL queries (A–F) for "trace this case_id",
  referenced by every runbook's Diagnosis §1.
- **`docs/adr/ADR-016-dashboard-data-pushgateway.md`**: pushgateway snapshot
  over postgres_exporter (OLTP untouched, single definition via the shared
  repo function, cohort label hygiene, visible staleness) and over direct
  Grafana→Postgres (would bypass API RBAC).

---

## 7. Load scripts, gate script, nightly workflow

- **`infra/load/k6-smoke.js`**: staging mix — webhook burst 100 rps × 60s
  (signed, unique ids) + reads 50 rps × 60s, thresholds `webhook p95<300ms`,
  `reads p95<500ms`, `checks==1.0`. Secrets via `-e` only.
- **`scripts/load-lite.mjs`**: zero-dependency (k6-free) bun measurer —
  pure benches (policy/risk/LLM-fallback) + live phases (signed webhooks,
  session-authed reads, duplicate storm) with percentile stats and a
  spec-03-§10 verdict block; writes the result JSON consumed by
  PERFORMANCE.md and the gate.
- **`scripts/monitoring-check.mjs`**: the executable Tests §1–2 —
  exact 14-alert set, thresholds, runbook existence/owner/no-TBD, metric
  references resolved against the real registry source, dashboard validity,
  wiring, PII label audit, plus the >20% perf-regression comparison arm.
  Wired into CI (`ci.yml` build job) beside `deploy-check`.
- **`.github/workflows/perf-gate.yml`**: nightly 03:00 UTC —
  monitoring-check (+ promtool when present), infra-free bench +
  regression vs baseline, and a secrets-gated staging k6 + load-lite run
  whose artifacts feed baseline promotion (procedure in the header).

---

## 8. Performance measurement story (incl. two artifacts caught)

Final co-located numbers (local compose Postgres, `baseline.local.json`
archived): **webhook p95 50.9ms** (300/300 ACCEPTED), **reads p95 15.4ms**
(200/200), **policy p95 0.02ms**, **risk p95 0.01ms**, **duplicates 1+49**,
**audit 0 failures**, LLM fallback p95 0.0ms with the live-model cell
explicitly marked staging-TODO (dev key unset — probe 401s in 677ms; the
s-15 harness owns the live typical with its <2,500ms mean gate).

Two measurement artifacts were caught and documented in PERFORMANCE.md §3
so nobody re-learns them: (1) `NullBus` awaits consumers inline, dragging
the risk→case→LLM cascade into the response window (p95 **14.6s**) —
production never does (`publish().then(markProcessed)`), so load-lite uses
a fire-and-forget black-hole bus; (2) cross-region DB RTT dominates
everything (924ms `SELECT 1` ⇒ 2.6s p95) — ingest must be measured
co-located, which staging is.

---

## 9. Tests + degraded-mode banner

- `packages/observability/src/monitoring-s34.test.ts` (6 tests): every new
  gauge/setter incl. saturation clamping and the PII-free exposition sweep.
- `apps/backend/src/tests/monitoring-s34.test.ts` (16 tests): exact alert
  set, per-alert threshold + reviewed-runbook assertions, dashboard panel
  requirements, KPI mapping/accumulation/push (incl. failure degradation),
  sampler probes (incl. the throw⇒0 pollers paging path), and the
  synthetic firing drill through the real gauge→exposition path for the
  three drillable page signals.
- `packages/config/src/cron.test.ts` (+3 monitoring tests) and
  `apps/backend/src/jobs/scheduler.test.ts` (+1 registration test).
- Frontend (`apps/frontend`): `lib/degraded-mode.ts` (SSR-safe toggle
  helper + doctrine copy), `DegradedModeBanner` switch+banner wired into
  Settings → Tenant Profile, and 3 unit tests (default-off, copy contract,
  hostile-storage safety).

---

## 10. Verification evidence (Definition of Done)

| DoD item | Evidence |
|---|---|
| Four dashboards live w/ real staging data | Dashboards-as-code provisioned + verified live locally (panels query real series); staging-data cutover is the operator step in `firing-drill.md` (no staging account reachable from here) |
| Alerts routed incl. tested paging path | `alertmanager.yml` page/ticket/warn routing; top-3 drill procedure + evidence log in `firing-drill.md`; local executable drill (gauge→expression tests + `monitoring-check`) green in CI |
| 12+ runbooks, no TBD owners | 14 alert runbooks + firing-drill (18 files under `docs/runbooks/`); gate asserts `Owner:` present and `TBD` absent |
| PERFORMANCE.md measured vs six targets | 5/6 fully measured + duplicates proof; LLM live-model explicitly pending staging key (fallback measured, harness mechanism cited) |
| Nightly load gate; baseline archived | `perf-gate.yml` (nightly 03:00 UTC) + `infra/load/baseline.local.json` committed; promotion procedure in workflow header |

Repo gates: `bun run check-types` · `bun run lint` · targeted suites
(6 + 16 + 3 + 27 green) · `bun run check-docs` · `monitoring-check` PASS
· `deploy-check` PASS · full `infra:up --wait` healthy · Prometheus 6/6
targets up, 14/14 rules loaded.

---

## 11. Deviations and judgment calls

1. **BusDLQDepth has two arms** (gauge + counter-increase): the gauge only
   reflects the in-process driver's true parked count; Redpanda depth comes
   from topic offsets, so the counter arm keeps the alert honest on both
   drivers.
2. **Default Temporal probe reports 0 on any failure** rather than leaving
   the gauge stale — an unobservable queue is operationally identical to a
   halted one; the runbook (not the metric) disambiguates.
3. **`freeSlots` defaults to the poller count** (documented liveness floor);
   true slot pressure still reads from Temporal UI until a worker exporter
   lands — recorded in code + runbook, not silently invented.
4. **LLM live-model latency is explicitly unmeasured**, not estimated. A
   fabricated number would violate the step's own "measure, don't claim"
   rule; the fallback path, harness mechanism, timeout/retry construction
   bound, and exact staging command are all recorded instead.
5. **Local cohort label is `local`** (compose) while the default config
   cohort is `staging` — honesty over convenience; dashboards group by
   `tenant` so nothing breaks.
6. **No new API endpoints** (e.g. no DLQ-resolve endpoint): DLQ resolution
   flows through the existing audited `POST /events/replay` — new surface
   would have exceeded the step's scope.
7. Pre-existing s-33 working-tree changes were left as found; the only
   shared-file edits are additive (metrics, config schema, jobs registry,
   crons doc, CI build job).
