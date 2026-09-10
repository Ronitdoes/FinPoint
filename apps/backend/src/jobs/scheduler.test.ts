import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerJobs } from "./index";
import { scheduleCronJob } from "./scheduler";

function fakeApp() {
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as FastifyInstance;
}

describe("scheduleCronJob (s-33)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires runOnce on every interval tick", async () => {
    vi.useFakeTimers();
    const runOnce = vi.fn().mockResolvedValue({ ok: true });
    const stop = scheduleCronJob(fakeApp(), {
      name: "test-job",
      intervalMs: 1000,
      runOnce,
    });
    try {
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(runOnce).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });

  it("skips overlapping ticks instead of running them in parallel", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runOnce = vi.fn().mockReturnValue(gate);
    const app = fakeApp();
    const stop = scheduleCronJob(app, {
      name: "slow-job",
      intervalMs: 1000,
      runOnce,
    });
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(runOnce).toHaveBeenCalledTimes(1);
      // Second tick fires while the first is still in flight → skipped.
      await vi.advanceTimersByTimeAsync(1000);
      expect(runOnce).toHaveBeenCalledTimes(1);
      expect(app.log.warn).toHaveBeenCalledWith(
        { job: "slow-job" },
        expect.stringContaining("skipped"),
      );
      release();
      await vi.advanceTimersByTimeAsync(1000);
      expect(runOnce).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });

  it("logs tick failures and keeps the schedule alive", async () => {
    vi.useFakeTimers();
    const runOnce = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ ok: true });
    const app = fakeApp();
    const stop = scheduleCronJob(app, {
      name: "flaky-job",
      intervalMs: 1000,
      runOnce,
    });
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(app.log.error).toHaveBeenCalledWith(
        expect.objectContaining({ job: "flaky-job" }),
        "cron tick failed",
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(runOnce).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });

  it("stop() prevents further ticks", async () => {
    vi.useFakeTimers();
    const runOnce = vi.fn().mockResolvedValue(undefined);
    const stop = scheduleCronJob(fakeApp(), {
      name: "stoppable-job",
      intervalMs: 1000,
      runOnce,
    });
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runOnce).toHaveBeenCalledTimes(1);
  });
});

describe("registerJobs (s-33 inventory)", () => {
  it("registers nothing and still decorates stopJobs when all jobs are off", () => {    const decorated: Record<string, unknown> = {};
    const hooks: unknown[] = [];
    const app = {
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      decorate: vi.fn((key: string, value: unknown) => {
        decorated[key] = value;
      }),
      addHook: vi.fn((...args: unknown[]) => {
        hooks.push(args);
      }),
    } as unknown as FastifyInstance;

    const stop = registerJobs(app, {});
    expect(typeof stop).toBe("function");
    expect(typeof decorated["stopJobs"]).toBe("function");
    stop();
  });

  it("registers s-34 kpi-snapshot + infra-sampler jobs when enabled (no ticks without time passing)", () => {
    const decorated: Record<string, unknown> = {};
    const app = {
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      decorate: vi.fn((key: string, value: unknown) => {
        decorated[key] = value;
      }),
      addHook: vi.fn(),
      db: {},
      config: { temporal: { address: "localhost:7233", namespace: "revenue-recovery", taskQueue: "recovery-main" } },
    } as unknown as FastifyInstance;

    const stop = registerJobs(app, {
      kpiSnapshot: { enabled: true, intervalMs: 300000, cohortLabel: "staging", pushGatewayUrl: null },
      infraSampler: { enabled: true, intervalMs: 60000 },
    });
    expect(typeof stop).toBe("function");
    expect(typeof decorated["stopJobs"]).toBe("function");
    stop();
  });
});
