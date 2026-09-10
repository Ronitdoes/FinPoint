# ADR-016 — Business KPIs on Grafana via Pushgateway Snapshot (not OLTP scrapes)

- **Status:** Accepted
- **Date:** 2026-09-10
- **Deciders:** Engineering (step s-34)
- **Related specs:** `specs/00-brainstorm-and-product-vision.md` §9 (metric catalog), `specs/steps/s-34.md` (dashboard-data decision)

## Context

The Executive dashboard needs business KPIs (Revenue at Risk / Recovered /
Recovery Rate / Net / Active Cases / Escalations) on Grafana. Two candidate
paths existed:

1. **postgres_exporter with analytics views** — Prometheus scrapes the
   `analytics.*` views on every scrape interval through a read-replica-safe
   role.
2. **Scheduled pushgateway snapshot from the analytics service** — a 5-minute
   job queries the analytics views with the service role and pushes the
   resulting scalars to the Prometheus pushgateway.

## Decision

**Option 2 (pushgateway snapshot).** Implemented as
`apps/backend/src/jobs/kpi-snapshot.ts` (`KpiSnapshotJob`, every
`KPI_SNAPSHOT_INTERVAL_MS`, default 5m), refreshing the in-process `kpi_*`
gauges and PUT-ing the identical exposition to
`PUSHGATEWAY_URL/metrics/job/arr-kpi/tenant/<cohort>`.

Reasons:

1. **OLTP untouched.** Analytics views aggregate `recovery_cases`,
   `recovery_outcomes`, and cost entries. Scraping them every 15s from an
   exporter multiplies analytical load on the write path; a 5-minute
   service-role query matches the dashboard API's own 30s-cache freshness
   contract while costing one query per tenant per 5 minutes.
2. **Numbers identical to the dashboard API by construction.** The job calls
   `getAnalyticsSummary` — the exact repository function behind
   `GET /analytics/summary` — instead of re-implementing the aggregation in
   exporter SQL. One definition, two presentations; drift is impossible
   without deleting the shared function.
3. **Label hygiene.** Per-tenant UUIDs are summed into a single
   `tenant=staging|prod` cohort series inside the process (CONVENTIONS §12),
   so no business PII or high-cardinality tenant key ever reaches
   Prometheus. A per-tenant exporter view would need equivalent redaction
   logic in SQL — worse place for it.
4. **Failure semantics favor snapshots.** A stale pushgateway series is
   visibly timestamped (alert `RecoveredAmountDrop` detects freezes via the
   7-day comparison going flat only if values drop; staleness itself is
   covered by `MonitoringPipelineDown` on the pushgateway target). A failed
   exporter scrape is silent absence.

## Consequences

- New runtime dependency: pushgateway in staging+prod (already in local
  compose as `arr-pushgateway`; Prometheus federates it via the `pushgateway`
  scrape job). If `PUSHGATEWAY_URL` is unset, gauges still refresh
  in-process — Grafana reads them from the API scrape target (single
  replica); the push path is then simply absent.
- Freshness floor is 5 minutes for business KPIs; operational/AI/infra
  panels stay at 15s scrape resolution. Documented on the Executive
  dashboard description.
- postgres_exporter remains for **infra** signals (connections, bloat, slow
  queries) with the analytics views explicitly NOT allowlisted — recorded
  here so a future exporter change doesn't silently re-add OLTP scraping.

## Alternatives considered

- **postgres_exporter on analytics views:** rejected per reasons 1–3 above.
- **Direct Grafana→Postgres datasource:** rejected — Grafana would need DB
  credentials and tenant-scoping logic outside the API's RBAC boundary
  (spec 02 §15, ADR-012). All business reads stay behind the API or its
  service-role jobs.
