import { describe, expect, it } from "vitest";

import { apiConfig, ConfigValidationError } from "./index";

/** Baseline env satisfying every hard requirement; tests mutate from here. */
function baseEnv(): Record<string, string> {
  return {
    NODE_ENV: "development",
    PORT: "8000",
    LOG_LEVEL: "info",
    DATABASE_URL: "postgres://postgres:postgres@localhost:5432/revenue_recovery",
    REDIS_URL: "redis://localhost:6379",
    TEMPORAL_ADDRESS: "localhost:7233",
    TEMPORAL_NAMESPACE: "revenue-recovery",
    EVENT_BUS_DRIVER: "inprocess",
    AI_MODEL: "gpt-4o",
    MOCK_PROVIDERS: "true",
  };
}

describe("cron config (s-33)", () => {
  it("applies documented default cadences", () => {
    const config = apiConfig(baseEnv());
    expect(config.cron.enabled).toBe(true);
    expect(config.cron.attributionSweepIntervalMs).toBe(60 * 60 * 1000);
    expect(config.cron.costAuditIntervalMs).toBe(24 * 60 * 60 * 1000);
    expect(config.cron.reconcileIntervalMs).toBe(24 * 60 * 60 * 1000);
    expect(config.cron.retentionSweepIntervalMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(Object.isFrozen(config.cron)).toBe(true);
  });

  it("is disabled by default in test env, enabled elsewhere", () => {
    const testEnv = { ...baseEnv(), NODE_ENV: "test" };
    expect(apiConfig(testEnv).cron.enabled).toBe(false);

    const prodEnv = { ...baseEnv(), NODE_ENV: "production" };
    expect(apiConfig(prodEnv).cron.enabled).toBe(true);
  });

  it("honors explicit CRON_ENABLED overrides", () => {
    expect(
      apiConfig({ ...baseEnv(), NODE_ENV: "test", CRON_ENABLED: "true" }).cron
        .enabled,
    ).toBe(true);
    expect(
      apiConfig({ ...baseEnv(), CRON_ENABLED: "false" }).cron.enabled,
    ).toBe(false);
  });

  it("honors per-job interval overrides", () => {
    const config = apiConfig({
      ...baseEnv(),
      ATTRIBUTION_SWEEP_INTERVAL_MS: "60000",
      COST_AUDIT_INTERVAL_MS: "120000",
      RECONCILE_INTERVAL_MS: "180000",
      RETENTION_SWEEP_INTERVAL_MS: "240000",
    });
    expect(config.cron.attributionSweepIntervalMs).toBe(60000);
    expect(config.cron.costAuditIntervalMs).toBe(120000);
    expect(config.cron.reconcileIntervalMs).toBe(180000);
    expect(config.cron.retentionSweepIntervalMs).toBe(240000);
  });

  it("rejects non-positive intervals", () => {
    try {
      apiConfig({ ...baseEnv(), ATTRIBUTION_SWEEP_INTERVAL_MS: "0" });
      expect.fail("expected ConfigValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).message).toContain(
        "ATTRIBUTION_SWEEP_INTERVAL_MS",
      );
    }
  });
});

describe("monitoring config (s-34)", () => {
  it("applies documented defaults (push off, staging cohort, 5m/60s cadences)", () => {
    const config = apiConfig(baseEnv());
    expect(config.monitoring.pushGatewayUrl).toBeNull();
    expect(config.monitoring.cohort).toBe("staging");
    expect(config.monitoring.kpiSnapshotIntervalMs).toBe(5 * 60 * 1000);
    expect(config.monitoring.infraSamplerIntervalMs).toBe(60 * 1000);
    expect(Object.isFrozen(config.monitoring)).toBe(true);
  });

  it("honors explicit monitoring overrides", () => {
    const config = apiConfig({
      ...baseEnv(),
      PUSHGATEWAY_URL: "http://pushgateway:9091",
      MONITORING_COHORT: "prod",
      KPI_SNAPSHOT_INTERVAL_MS: "60000",
      INFRA_SAMPLER_INTERVAL_MS: "30000",
    });
    expect(config.monitoring.pushGatewayUrl).toBe("http://pushgateway:9091");
    expect(config.monitoring.cohort).toBe("prod");
    expect(config.monitoring.kpiSnapshotIntervalMs).toBe(60000);
    expect(config.monitoring.infraSamplerIntervalMs).toBe(30000);
  });

  it("rejects malformed pushgateway URLs and non-positive intervals", () => {
    try {
      apiConfig({ ...baseEnv(), PUSHGATEWAY_URL: "not-a-url" });
      expect.fail("expected ConfigValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
    }
    try {
      apiConfig({ ...baseEnv(), KPI_SNAPSHOT_INTERVAL_MS: "0" });
      expect.fail("expected ConfigValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
    }
  });
});
