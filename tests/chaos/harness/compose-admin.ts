/**
 * Infrastructure kill-drill administration (Step 31 §Requirements 2).
 *
 * Scripted `docker` operations against the local compose stack:
 * - `docker restart redis` during active rate-limit/cache use
 * - Postgres connection drop (`docker pause` 30s) with pool reconnect
 * - Temporal worker SIGKILL mid-workflow round
 * - Redpanda unreachable (producer buffer / consumer backlog drain)
 *
 * Safety: every drill refuses to run against prod-shaped environments, and
 * all drills are skipped unless `CHAOS_INFRA=1` (nightly compose profile).
 * The fast CI subset exercises the same degraded behaviors via fakes and
 * records `skipped` drill reports; the JSON report artifact attaches to the
 * CI summary (Step 31 §Observability).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DrillReport {
  drill: string;
  command: string[];
  startedAt: string;
  endedAt: string;
  skipped: boolean;
  skipReason?: string;
  exitCode?: number;
  outputTail?: string;
}

const PROD_SHAPED_ENV = ["production", "prod", "live"];

/** Throws when the current environment looks like production. */
export function assertNonProd(): void {
  const candidates = [
    process.env.NODE_ENV,
    process.env.APP_ENV,
    process.env.CHAOS_TARGET,
  ].filter(Boolean) as string[];
  for (const value of candidates) {
    if (PROD_SHAPED_ENV.includes(value.toLowerCase())) {
      throw new Error(
        `Chaos drills refuse to target prod-shaped environment (saw '${value}'). ` +
          "Run only against dev/test tenants.",
      );
    }
  }
}

/** Full infra-kill matrix runs only under the nightly compose profile flag. */
export function isInfraKillEnabled(): boolean {
  return process.env.CHAOS_INFRA === "1";
}

function emptyReport(drill: string, command: string[], reason: string): DrillReport {
  const now = new Date().toISOString();
  return {
    drill,
    command,
    startedAt: now,
    endedAt: now,
    skipped: true,
    skipReason: reason,
  };
}

function runDocker(args: string[], drill: string): DrillReport {
  const startedAt = new Date().toISOString();
  try {
    const output = execFileSync("docker", args, {
      encoding: "utf8",
      timeout: 120000,
    });
    return {
      drill,
      command: ["docker", ...args],
      startedAt,
      endedAt: new Date().toISOString(),
      skipped: false,
      exitCode: 0,
      outputTail: output.slice(-2000),
    };
  } catch (err: any) {
    return {
      drill,
      command: ["docker", ...args],
      startedAt,
      endedAt: new Date().toISOString(),
      skipped: false,
      exitCode: typeof err?.status === "number" ? err.status : 1,
      outputTail: String(err?.message ?? err).slice(-2000),
    };
  }
}

function guarded(drill: string, command: string[], run: () => DrillReport): DrillReport {
  assertNonProd();
  if (!isInfraKillEnabled()) {
    return emptyReport(
      drill,
      command,
      "CHAOS_INFRA!=1: infra-kill drills run in the nightly compose profile only; fast CI subset uses fakes",
    );
  }
  return run();
}

/** Restart Redis mid-use; callers assert degraded-not-dead behavior + recovery. */
export function drillRestartRedis(container = "ai-revenue-recovery-redis-1"): DrillReport {
  return guarded("redis-down", ["docker", "restart", container], () =>
    runDocker(["restart", container], "redis-down"),
  );
}

/** Freeze Postgres I/O for `seconds`, then unpause; pool must reconnect. */
export function drillPausePostgres(
  container = "ai-revenue-recovery-postgres-1",
  seconds = 30,
): DrillReport {
  return guarded("postgres-reconnect", ["docker", "pause/unpause", container], () => {
    const paused = runDocker(["pause", container], "postgres-reconnect");
    if (paused.exitCode !== 0) return paused;
    execFileSync("sleep", [String(seconds)], { timeout: (seconds + 10) * 1000 });
    return runDocker(["unpause", container], "postgres-reconnect");
  });
}

/** SIGKILL the Temporal worker container mid-round; workflows resume from history. */
export function drillKillWorker(container = "ai-revenue-recovery-worker-1"): DrillReport {
  return guarded("worker-crash", ["docker", "kill", "-s", "SIGKILL", container], () =>
    runDocker(["kill", "-s", "SIGKILL", container], "worker-crash"),
  );
}

/** Stop Redpanda to simulate an unreachable bus; consumers must drain backlog on return. */
export function drillStopRedpanda(
  container = "ai-revenue-recovery-redpanda-1",
): DrillReport {
  return guarded("redpanda-down", ["docker", "stop", container], () =>
    runDocker(["stop", container], "redpanda-down"),
  );
}

/** Restarts a previously stopped Redpanda container (backlog-drain second half). */
export function drillStartRedpanda(
  container = "ai-revenue-recovery-redpanda-1",
): DrillReport {
  return guarded("redpanda-up", ["docker", "start", container], () =>
    runDocker(["start", container], "redpanda-up"),
  );
}

/**
 * Writes a JSON drill-report artifact for the CI summary.
 * Returns the artifact path.
 */
export function writeDrillReport(
  report: DrillReport | DrillReport[],
  outDir = "artifacts/chaos",
): string {
  const reports = Array.isArray(report) ? report : [report];
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `chaos-drills-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2));
  return path;
}
