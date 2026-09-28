import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// packages/observability/src -> repo root is ../../..
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const COMPOSE_PATH = path.join(REPO_ROOT, "infra", "docker", "docker-compose.yml");
const COLLECTOR_CONFIG_PATH = path.join(
  REPO_ROOT,
  "infra",
  "docker",
  "otel-collector-config.yaml",
);

/**
 * s-08 otel-collector wiring (LOW-RISK config-level test, no live infra).
 *
 * Asserts the collector is wired without requiring a running collector:
 * compose service presence + OTLP ports, backend/worker OTLP endpoint env,
 * and the collector config's OTLP receivers. If the compose file or config
 * is restructured, update this test alongside it.
 */
describe("s-08 otel-collector wiring (config-level, no live collector)", () => {
  it("declares the otel-collector service with OTLP gRPC/HTTP ports", () => {
    expect(existsSync(COMPOSE_PATH), `missing ${COMPOSE_PATH}`).toBe(true);
    const compose = readFileSync(COMPOSE_PATH, "utf8");

    expect(compose).toContain("otel-collector:");
    // OTLP gRPC receiver
    expect(compose).toContain("4317:4317");
    // OTLP HTTP receiver
    expect(compose).toContain("4318:4318");
  });

  it("points backend and worker at the collector via OTLP HTTP endpoint env", () => {
    const compose = readFileSync(COMPOSE_PATH, "utf8");
    // Both api and worker export to the collector over OTLP/HTTP (port 4318).
    expect(compose).toContain("OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318");
  });

  it("configures OTLP grpc+http receivers in the collector config", () => {
    expect(existsSync(COLLECTOR_CONFIG_PATH), `missing ${COLLECTOR_CONFIG_PATH}`).toBe(
      true,
    );
    const config = readFileSync(COLLECTOR_CONFIG_PATH, "utf8");

    expect(config).toContain("otlp:");
    expect(config).toContain("0.0.0.0:4317");
    expect(config).toContain("0.0.0.0:4318");
    // Pipelines must include traces/metrics/logs so nothing is silently dropped.
    expect(config).toContain("traces:");
    expect(config).toContain("metrics:");
    expect(config).toContain("logs:");
  });
});
