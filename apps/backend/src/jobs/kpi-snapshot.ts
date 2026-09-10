import {
  setKpiSnapshot,
  type KpiSnapshot,
} from "@repo/observability";
import {
  getAnalyticsSummary,
  listTenants,
  type AnalyticsSummaryResult,
  type Database,
} from "@repo/db";

/**
 * Business KPI snapshot job (s-34, ADR-016).
 *
 * Every 5 minutes this job re-reads the authoritative analytics views
 * (`getAnalyticsSummary` per tenant — the same source the dashboard API
 * serves) and:
 *   1. refreshes the in-process `kpi_*` gauges scraped at `GET /metrics`
 *      (Executive dashboard), and
 *   2. mirrors the identical values to the Prometheus pushgateway with a
 *      single low-cardinality `tenant=<cohort>` label (staging|prod).
 *
 * Label discipline (CONVENTIONS §12): per-tenant UUIDs never leave the
 * process — tenants are summed into one cohort series so no business PII
 * or high-cardinality tenant key ever lands in an exported label. Numbers
 * are identical to the dashboard API by construction (same query).
 */

export const KPI_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

export interface KpiSnapshotJobDeps {
  db?: Database;
  /** Paged tenant enumeration; defaults to `listTenants`. */
  listTenantIds?: () => Promise<string[]>;
  /** Per-tenant summary read; defaults to `getAnalyticsSummary`. */
  getSummary?: (tenantId: string) => Promise<AnalyticsSummaryResult>;
  /** Cohort label written to gauges/pushgateway (`staging`|`prod`). */
  cohortLabel?: string;
  /** Pushgateway base URL (`PUSHGATEWAY_URL`); push skipped when unset. */
  pushGatewayUrl?: string | null;
  fetchImpl?: typeof fetch;
  onLog?: (level: "info" | "warn" | "error", msg: string, extra?: unknown) => void;
}

export interface KpiSnapshotRunResult {
  tenants: number;
  pushed: boolean;
  snapshot: KpiSnapshot;
}

/**
 * Pure mapping from the analytics summary row to the Prometheus snapshot.
 * Minor-unit bigints are narrowed with `Number()` — snapshot magnitudes
 * (paise) stay exactly representable far beyond any realistic ledger total
 * (< 2^53 minor units ≈ ₹90T); recovery_rate converts bps → 0..1 fraction.
 */
export function buildKpiSnapshot(
  summary: Pick<
    AnalyticsSummaryResult,
    | "revenue_at_risk_minor"
    | "revenue_recovered_minor"
    | "net_recovered_minor"
    | "recovery_rate_bps"
    | "active_cases"
    | "escalations"
  >,
  tenant: string,
): KpiSnapshot {
  return {
    tenant,
    revenueAtRiskMinor: Number(summary.revenue_at_risk_minor),
    revenueRecoveredMinor: Number(summary.revenue_recovered_minor),
    netRecoveredMinor: Number(summary.net_recovered_minor),
    recoveryRate:
      summary.recovery_rate_bps > 0 ? summary.recovery_rate_bps / 10000 : 0,
    activeCases: summary.active_cases,
    escalations: summary.escalations,
  };
}

/** Sums per-tenant snapshots into one cohort snapshot (rate recomputed from totals). */
export function accumulateKpiSnapshots(
  snaps: KpiSnapshot[],
  tenant: string,
): KpiSnapshot {
  let revenueAtRiskMinor = 0;
  let revenueRecoveredMinor = 0;
  let netRecoveredMinor = 0;
  let activeCases = 0;
  let escalations = 0;
  for (const s of snaps) {
    revenueAtRiskMinor += s.revenueAtRiskMinor;
    revenueRecoveredMinor += s.revenueRecoveredMinor;
    netRecoveredMinor += s.netRecoveredMinor;
    activeCases += s.activeCases;
    escalations += s.escalations;
  }
  return {
    tenant,
    revenueAtRiskMinor,
    revenueRecoveredMinor,
    netRecoveredMinor,
    recoveryRate:
      revenueAtRiskMinor > 0 ? revenueRecoveredMinor / revenueAtRiskMinor : 0,
    activeCases,
    escalations,
  };
}

/** Renders the snapshot in Prometheus text exposition format for pushgateway PUT. */
export function formatKpiPushgatewayBody(snap: KpiSnapshot): string {
  const l = `tenant="${snap.tenant}"`;
  const lines = [
    "# HELP kpi_revenue_at_risk_minor Revenue at risk in integer minor units, analytics view snapshot",
    "# TYPE kpi_revenue_at_risk_minor gauge",
    `kpi_revenue_at_risk_minor{${l}} ${snap.revenueAtRiskMinor}`,
    "# HELP kpi_revenue_recovered_minor Revenue recovered in integer minor units, analytics view snapshot",
    "# TYPE kpi_revenue_recovered_minor gauge",
    `kpi_revenue_recovered_minor{${l}} ${snap.revenueRecoveredMinor}`,
    "# HELP kpi_net_recovered_minor Net recovered in integer minor units, analytics view snapshot",
    "# TYPE kpi_net_recovered_minor gauge",
    `kpi_net_recovered_minor{${l}} ${snap.netRecoveredMinor}`,
    "# HELP kpi_recovery_rate Recovery rate fraction 0..1 from the analytics summary view",
    "# TYPE kpi_recovery_rate gauge",
    `kpi_recovery_rate{${l}} ${snap.recoveryRate}`,
    "# HELP kpi_active_cases Current number of non-terminal recovery cases",
    "# TYPE kpi_active_cases gauge",
    `kpi_active_cases{${l}} ${snap.activeCases}`,
    "# HELP kpi_escalations_total Cumulative escalated recovery cases",
    "# TYPE kpi_escalations_total gauge",
    `kpi_escalations_total{${l}} ${snap.escalations}`,
  ];
  return lines.join("\n") + "\n";
}

/** Pushes one snapshot to the pushgateway (PUT replaces the job/tenant series). */
export async function pushKpiSnapshot(
  gatewayUrl: string,
  snap: KpiSnapshot,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const base = gatewayUrl.replace(/\/+$/, "");
  const url = `${base}/metrics/job/arr-kpi/tenant/${encodeURIComponent(snap.tenant)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetchImpl(url, {
      method: "PUT",
      headers: { "Content-Type": "text/plain; version=0.0.4" },
      body: formatKpiPushgatewayBody(snap),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`pushgateway PUT ${url} → ${res.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export class KpiSnapshotJob {
  private readonly deps: KpiSnapshotJobDeps;

  constructor(deps: KpiSnapshotJobDeps = {}) {
    this.deps = deps;
  }

  async runOnce(): Promise<KpiSnapshotRunResult> {
    const {
      db,
      cohortLabel = "staging",
      pushGatewayUrl = null,
      fetchImpl = fetch,
      onLog,
    } = this.deps;
    const log = onLog ?? (() => {});

    const listTenantIds =
      this.deps.listTenantIds ??
      (async () => {
        const ids: string[] = [];
        const limit = 100;
        let offset = 0;
        for (;;) {
          const page = await listTenants({ db }, { limit, offset });
          for (const t of page) ids.push(t.id);
          if (page.length < limit) break;
          offset += limit;
        }
        return ids;
      });

    const getSummary =
      this.deps.getSummary ??
      ((tenantId: string) => getAnalyticsSummary({ db }, { tenantId }));

    const perTenant: KpiSnapshot[] = [];
    let tenantIds: string[] = [];
    try {
      tenantIds = await listTenantIds();
    } catch (err) {
      log("warn", "kpi-snapshot tenant enumeration failed; emitting empty cohort", { err });
    }

    for (const tenantId of tenantIds) {
      try {
        const summary = await getSummary(tenantId);
        perTenant.push(buildKpiSnapshot(summary, cohortLabel));
      } catch (err) {
        // One tenant's failure never aborts the pass (same policy as s-33 crons).
        log("warn", "kpi-snapshot per-tenant summary failed; continuing", { err });
      }
    }

    const snapshot = accumulateKpiSnapshots(perTenant, cohortLabel);
    setKpiSnapshot(snapshot);

    let pushed = false;
    if (pushGatewayUrl) {
      try {
        await pushKpiSnapshot(pushGatewayUrl, snapshot, fetchImpl);
        pushed = true;
      } catch (err) {
        log("warn", "kpi-snapshot pushgateway push failed; gauges still refreshed", { err });
      }
    }
    log("info", "kpi-snapshot pass completed", {
      tenants: tenantIds.length,
      pushed,
    });
    return { tenants: tenantIds.length, pushed, snapshot };
  }
}
