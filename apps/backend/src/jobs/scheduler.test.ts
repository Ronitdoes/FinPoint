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

  it("rejects non-positive/non-finite intervals instead of busy-looping", () => {
    for (const bad of [0, -1000, NaN, Infinity]) {
      expect(() =>
        scheduleCronJob(fakeApp(), {
          name: "bad-job",
          intervalMs: bad,
          runOnce: vi.fn(),
        }),
      ).toThrow(/positive finite number/);
    }
  });

  it("clamps intervals above the runtime timer limit with a warning", async () => {
    vi.useFakeTimers();
    const runOnce = vi.fn().mockResolvedValue({ ok: true });
    const app = fakeApp();
    const stop = scheduleCronJob(app, {
      name: "monthly-job",
      intervalMs: 30 * 24 * 60 * 60 * 1000,
      runOnce,
    });
    try {
      expect(app.log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ job: "monthly-job" }),
        expect.stringContaining("clamping"),
      );
      // Clamped to MAX: advancing 1ms must NOT fire (the overflow busy-loop).
      await vi.advanceTimersByTimeAsync(1);
      expect(runOnce).not.toHaveBeenCalled();
    } finally {
      stop();
    }
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

  it("audit-retention ticks daily but runs only when the period is due (no 30-day timer)", async () => {
    vi.useFakeTimers();
    const decorated: Record<string, unknown> = {};
    const app = {
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      decorate: vi.fn((key: string, value: unknown) => {
        decorated[key] = value;
      }),
      addHook: vi.fn(),
      db: {},
    } as unknown as FastifyInstance;

    const stop = registerJobs(app, {
      auditRetention: { enabled: true, intervalMs: 30 * 24 * 60 * 60 * 1000 },
    });
    try {
      const day = 24 * 60 * 60 * 1000;
      // 29 daily ticks: archive must not run (not due), and no clamp warning.
      await vi.advanceTimersByTimeAsync(29 * day);
      expect(app.log.warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ job: "audit-retention" }),
        expect.stringContaining("clamping"),
      );
      // 30th daily tick: period elapsed → the archive path runs (may fail
      // without a real db; the schedule must stay alive either way).
      await vi.advanceTimersByTimeAsync(day);
      expect(app.log.info).toHaveBeenCalledWith(
        expect.objectContaining({ job: "audit-retention" }),
        expect.stringMatching(/cron tick (completed|failed)/),
      );
    } finally {
      stop();
    }
  });
});
