import { describe, expect, it, beforeEach, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resetMetrics,
  getMetricsText,
  recordAuditWriteFailure,
  setTemporalWorkerStats,
  setBusDlqDepth,
} from "@repo/observability";
import type { AnalyticsSummaryResult } from "@repo/db";
import {
  buildKpiSnapshot,
  accumulateKpiSnapshots,
  formatKpiPushgatewayBody,
  pushKpiSnapshot,
  KpiSnapshotJob,
} from "../jobs/kpi-snapshot";
import {
  computeSaturation,
  probeDbPoolFromDriver,
  InfraSampler,
} from "../jobs/infra-sampler";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

function repoFile(rel: string): string {
  const abs = join(REPO_ROOT, rel);
  if (!existsSync(abs)) throw new Error(`missing ${rel}`);
  return readFileSync(abs, "utf8");
}

function summaryStub(overrides: Partial<AnalyticsSummaryResult> = {}): AnalyticsSummaryResult {
  return {
    revenue_at_risk_minor: 1000000n,
    revenue_recovered_minor: 650000n,
    recovery_rate_bps: 6500,
    recovery_cost_minor: 72000n,
    net_recovered_minor: 578000n,
    recovery_roi_bps: 802,
    currency: "INR",
    active_cases: 10,
    escalations: 2,
    avg_time_to_recovery_seconds: 86400,
    ...overrides,
  };
}

describe("s-34 monitoring-as-code (alerts, dashboards, runbooks)", () => {
  it("defines the exact 14-alert set with no duplicates", () => {
    const src = repoFile("infra/prometheus/rules.yml");
    const names = [...src.matchAll(/\n\s+- alert: (\w+)/g)].map((m) => m[1]);
    expect(names).toHaveLength(14);
    expect(new Set(names).size).toBe(14);
    for (const required of [
      "WebhookErrorRate", "BusDLQDepth", "WorkflowFailureRate",
      "ProviderFailureRate", "LLMFallbackRate", "PolicyRejectionSpike",
      "RecoveredAmountDrop", "P95WebhookLatency", "DBPoolSaturation",
      "TemporalWorkerPollers", "AuditWriteFailures", "CertExpiry",
      "DiskFills", "MonitoringPipelineDown",
    ]) {
      expect(names).toContain(required);
    }
  });

  it("every alert carries the step-specified threshold and a reviewed runbook", () => {
    const src = repoFile("infra/prometheus/rules.yml");
    const cases: Array<[string, string, string]> = [
      ["WebhookErrorRate", "0.02", "webhook-error-rate.md"],
      ["WorkflowFailureRate", "0.01", "workflow-failure-rate.md"],
      ["ProviderFailureRate", "0.10", "provider-failure-rate.md"],
      ["LLMFallbackRate", "0.30", "llm-fallback-rate.md"],
      ["RecoveredAmountDrop", "0.5", "recovered-amount-drop.md"],
      ["P95WebhookLatency", "300", "p95-webhook-latency.md"],
      ["DBPoolSaturation", "0.8", "db-pool-saturation.md"],
      ["TemporalWorkerPollers", "== 0", "temporal-worker-pollers.md"],
      ["CertExpiry", "14", "cert-expiry.md"],
      ["DiskFills", "0.10", "disk-fills.md"],
    ];
    for (const [alert, threshold, runbook] of cases) {
      expect(src).toContain(`- alert: ${alert}`);
      const block = src.split(`- alert: ${alert}`)[1]!.split("- alert: ")[0]!;
      expect(block).toContain(threshold);
      const rb = repoFile(`docs/runbooks/${runbook}`);
      expect(rb).toMatch(/Owner:/);
      expect(rb).not.toMatch(/TBD/);
    }
  });

  it("four dashboards exist with required KPI/ops/AI/infra panels", () => {
    const required: Record<string, string[]> = {
      "executive.json": ["kpi_revenue_at_risk_minor", "kpi_recovery_rate", "kpi_active_cases"],
      "operations.json": ["webhook_deliveries_total", "bus_dlq_depth", "provider_calls_total"],
      "ai.json": ["llm_latency_ms", "fallback_total", "approval_oldest_age_seconds"],
      "infra.json": ["db_pool_saturation_ratio", "temporal_worker_pollers", "disk_free_ratio"],
    };
    for (const [file, metrics] of Object.entries(required)) {
      const dash = JSON.parse(repoFile(`infra/grafana/dashboards/${file}`));
      expect(dash.uid).toMatch(/^arr-/);
      expect(dash.panels.length).toBeGreaterThan(0);
      const joined = JSON.stringify(dash);
      for (const metric of metrics) expect(joined).toContain(metric);
    }
  });
});

describe("s-34 KPI snapshot job (pure mapping + push)", () => {
  it("maps bps/bigint summary rows to cohort snapshots", () => {
    const snap = buildKpiSnapshot(summaryStub(), "staging");
    expect(snap).toEqual({
      tenant: "staging",
      revenueAtRiskMinor: 1000000,
      revenueRecoveredMinor: 650000,
      netRecoveredMinor: 578000,
      recoveryRate: 0.65,
      activeCases: 10,
      escalations: 2,
    });
  });

  it("accumulates tenants into one cohort (rate recomputed from totals)", () => {
    const acc = accumulateKpiSnapshots(
      [
        buildKpiSnapshot(summaryStub({ revenue_at_risk_minor: 1000000n, revenue_recovered_minor: 500000n, net_recovered_minor: 450000n, active_cases: 4, escalations: 1 }), "staging"),
        buildKpiSnapshot(summaryStub({ revenue_at_risk_minor: 1000000n, revenue_recovered_minor: 800000n, net_recovered_minor: 700000n, active_cases: 6, escalations: 1 }), "staging"),
      ],
      "staging",
    );
    expect(acc.revenueAtRiskMinor).toBe(2000000);
    expect(acc.revenueRecoveredMinor).toBe(1300000);
    expect(acc.recoveryRate).toBeCloseTo(0.65, 10);
    expect(acc.activeCases).toBe(10);
  });

  it("pushes exposition with PUT to the job/tenant URL and throws on non-2xx", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    await pushKpiSnapshot("http://pushgateway:9091/", buildKpiSnapshot(summaryStub(), "staging"), fetchImpl as never);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://pushgateway:9091/metrics/job/arr-kpi/tenant/staging");
    expect(init.method).toBe("PUT");
    expect(String(init.body)).toContain('kpi_revenue_recovered_minor{tenant="staging"} 650000');

    const failing = vi.fn(async () => ({ ok: false, status: 500 }) as Response);
    await expect(
      pushKpiSnapshot("http://pushgateway:9091", buildKpiSnapshot(summaryStub(), "staging"), failing as never),
    ).rejects.toThrow("500");
  });

  it("runs a full pass from stubs: sums tenants, sets gauges, pushes once", async () => {
    resetMetrics();
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    const job = new KpiSnapshotJob({
      listTenantIds: async () => ["t1", "t2"],
      getSummary: async (id) =>
        summaryStub(id === "t1"
          ? { revenue_at_risk_minor: 1000000n, revenue_recovered_minor: 500000n, net_recovered_minor: 450000n, active_cases: 4, escalations: 1 }
          : { revenue_at_risk_minor: 1000000n, revenue_recovered_minor: 800000n, net_recovered_minor: 700000n, active_cases: 6, escalations: 1 }),
      cohortLabel: "staging",
      pushGatewayUrl: "http://pushgateway:9091",
      fetchImpl: fetchImpl as never,
      onLog: () => {},
    });
    const result = await job.runOnce();
    expect(result.tenants).toBe(2);
    expect(result.pushed).toBe(true);
    expect(result.snapshot.activeCases).toBe(10);
    const text = await getMetricsText();
    expect(text).toContain('kpi_active_cases{tenant="staging"} 10');
  });

  it("survives per-tenant summary failures and push failures (gauges still refresh)", async () => {
    resetMetrics();
    const job = new KpiSnapshotJob({
      listTenantIds: async () => ["t1", "bad"],
      getSummary: async (id) => {
        if (id === "bad") throw new Error("tenant db down");
        return summaryStub();
      },
      pushGatewayUrl: "http://pushgateway:9091",
      fetchImpl: (async () => { throw new Error("gateway down"); }) as never,
      onLog: () => {},
    });
    const result = await job.runOnce();
    expect(result.tenants).toBe(2);
    expect(result.pushed).toBe(false);
    expect(result.snapshot.activeCases).toBe(10);
  });
});

describe("s-34 infra sampler", () => {
  beforeEach(() => resetMetrics());

  it("computes saturation with zero-guard and clamping", () => {
    expect(computeSaturation(8, 10)).toBeCloseTo(0.8, 10);
    expect(computeSaturation(99, 10)).toBe(1);
    expect(computeSaturation(0, 0)).toBe(0);
    expect(computeSaturation(-3, 10)).toBe(0);
  });

  it("probes pg pool shapes and returns null when unrecognized", () => {
    expect(probeDbPoolFromDriver({ pool: { totalCount: 10, idleCount: 2, max: 10 } })).toEqual({ used: 8, max: 10 });
    expect(probeDbPoolFromDriver({})).toBeNull();
    expect(probeDbPoolFromDriver(null)).toBeNull();
  });

  it("writes all gauges from stub probes", async () => {
    const sampler = new InfraSampler({
      probeDbPool: () => ({ used: 4, max: 20 }),
      probeBusDlqDepth: () => 2,
      probeQueueStats: async () => ({ pollers: 3, freeSlots: 3 }),
      probeApprovalStats: async () => ({ openByType: { APPROVAL: 5 }, oldestAgeSeconds: 3600 }),
      onLog: () => {},
    });
    const result = await sampler.runOnce();
    expect(result).toEqual({
      dbPool: { used: 4, max: 20 },
      dlqDepth: 2,
      queue: { pollers: 3, freeSlots: 3 },
      approvals: { openByType: { APPROVAL: 5 }, oldestAgeSeconds: 3600 },
    });
    const text = await getMetricsText();
    expect(text).toContain("db_pool_saturation_ratio 0.2");
    expect(text).toContain('bus_dlq_depth{group="all"} 2');
    expect(text).toContain('temporal_worker_pollers{queue="recovery-main"} 3');
    expect(text).toContain("approval_oldest_age_seconds 3600");
  });

  it("reports zero pollers when the queue probe throws (paging path)", async () => {
    const sampler = new InfraSampler({
      probeDbPool: () => null,
      probeBusDlqDepth: () => null,
      probeQueueStats: async () => { throw new Error("temporal unreachable"); },
      probeApprovalStats: async () => null,
      onLog: () => {},
    });
    const result = await sampler.runOnce();
    expect(result.queue).toEqual({ pollers: 0, freeSlots: 0 });
  });
});

describe("s-34 synthetic firing drill (gauge → alert-expression path)", () => {
  beforeEach(() => resetMetrics());

  it("TemporalWorkerPollers fires on the exact series the rule matches", async () => {
    setTemporalWorkerStats("recovery-main", 0, 0);
    const text = await getMetricsText();
    // Rule: min_over_time(temporal_worker_pollers[5m]) == 0
    expect(text).toContain('temporal_worker_pollers{queue="recovery-main"} 0');
  });

  it("BusDLQDepth fires on parked depth", async () => {
    setBusDlqDepth("all", 1);
    const text = await getMetricsText();
    // Rule arm: max_over_time(bus_dlq_depth[15m]) > 0
    expect(text).toContain('bus_dlq_depth{group="all"} 1');
  });

  it("AuditWriteFailures fires on any increase", async () => {
    recordAuditWriteFailure();
    const text = await getMetricsText();
    // Rule: increase(audit_write_failures_total[15m]) > 0
    expect(text).toContain("audit_write_failures_total 1");
  });
});

describe("s-34 pushgateway body format", () => {
  it("renders valid exposition with HELP/TYPE headers", () => {
    const body = formatKpiPushgatewayBody(buildKpiSnapshot(summaryStub(), "prod"));
    expect(body).toContain('kpi_recovery_rate{tenant="prod"} 0.65');
    expect(body).toContain("# TYPE kpi_active_cases gauge");
    expect(body).not.toMatch(/tenant_id|case_id|email/);
  });
});
