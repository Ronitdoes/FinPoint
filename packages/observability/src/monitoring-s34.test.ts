import { describe, it, expect, beforeEach } from "vitest";
import {
  resetMetrics,
  getMetricsText,
  setBusDlqDepth,
  setBusConsumerLag,
  setDbPoolStats,
  setTemporalWorkerStats,
  setApprovalOldestAge,
  setKpiSnapshot,
  setCertExpiryDays,
  setDiskFreeRatio,
  setRedisMemoryRatio,
} from "./metrics";

describe("s-34 monitoring instruments", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("tracks bus DLQ depth and consumer lag per group", async () => {
    setBusDlqDepth("orchestrator", 3);
    setBusConsumerLag("orchestrator", 12.5);
    const text = await getMetricsText();
    expect(text).toContain('bus_dlq_depth{group="orchestrator"} 3');
    expect(text).toContain('bus_consumer_lag_seconds{group="orchestrator"} 12.5');
  });

  it("computes db pool saturation ratio with clamping", async () => {
    setDbPoolStats(8, 10);
    let text = await getMetricsText();
    expect(text).toContain("db_pool_used 8");
    expect(text).toContain("db_pool_max 10");
    expect(text).toContain("db_pool_saturation_ratio 0.8");

    setDbPoolStats(99, 10);
    text = await getMetricsText();
    expect(text).toContain("db_pool_saturation_ratio 1");

    setDbPoolStats(0, 0);
    text = await getMetricsText();
    expect(text).toContain("db_pool_saturation_ratio 0");
  });

  it("exposes temporal worker pollers per queue (paging signal)", async () => {
    setTemporalWorkerStats("recovery-main", 0, 0);
    const text = await getMetricsText();
    expect(text).toContain('temporal_worker_pollers{queue="recovery-main"} 0');
  });

  it("tracks approval queue age with floor at zero", async () => {
    setApprovalOldestAge(3725);
    let text = await getMetricsText();
    expect(text).toContain("approval_oldest_age_seconds 3725");
    setApprovalOldestAge(-5);
    text = await getMetricsText();
    expect(text).toContain("approval_oldest_age_seconds 0");
  });

  it("sets the full KPI cohort snapshot with staging|prod-style labels", async () => {
    setKpiSnapshot({
      tenant: "staging",
      revenueAtRiskMinor: 1280000,
      revenueRecoveredMinor: 840000,
      netRecoveredMinor: 768000,
      recoveryRate: 0.654,
      activeCases: 182,
      escalations: 21,
    });
    const text = await getMetricsText();
    expect(text).toContain('kpi_revenue_at_risk_minor{tenant="staging"} 1280000');
    expect(text).toContain('kpi_revenue_recovered_minor{tenant="staging"} 840000');
    expect(text).toContain('kpi_net_recovered_minor{tenant="staging"} 768000');
    expect(text).toContain('kpi_recovery_rate{tenant="staging"} 0.654');
    expect(text).toContain('kpi_active_cases{tenant="staging"} 182');
    expect(text).toContain('kpi_escalations_total{tenant="staging"} 21');
  });

  it("exports ops-hygiene gauges without PII labels", async () => {
    setCertExpiryDays("dashboard.example.com", 42);
    setDiskFreeRatio("/var/lib/postgresql", 0.35);
    setRedisMemoryRatio(0.62);
    const text = await getMetricsText();
    expect(text).toContain('cert_expiry_days{host="dashboard.example.com"} 42');
    expect(text).toContain('disk_free_ratio{mountpoint="/var/lib/postgresql"} 0.35');
    expect(text).toContain("redis_memory_ratio 0.62");
    expect(text).not.toMatch(/tenant_id|case_id|email|phone/);
  });
});
