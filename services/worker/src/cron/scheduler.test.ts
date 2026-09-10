import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkerCronScheduler } from "./scheduler";

describe("WorkerCronScheduler (s-33)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runOnce over zero tenants touches no tenant work and reports zeros", async () => {
    const scheduler = new WorkerCronScheduler({
      listTenantIds: async () => [],
    });
    const result = await scheduler.runOnce();
    expect(result).toEqual({
      tenants: 0,
      orphanedInvoicesEmitted: 0,
      expiredPromisesResolved: 0,
    });
  });

  it("aggregates per-tenant reconciler results", async () => {
    const scheduler = new WorkerCronScheduler({
      listTenantIds: async () => ["t-1", "t-2"],
    });
    const inner = (scheduler as unknown as { reconciler: unknown })
      .reconciler as {
      reconcileOrphanedInvoices: (tenantId: string) => Promise<unknown>;
      reconcileExpiredPromises: (tenantId: string) => Promise<unknown>;
    };
    inner.reconcileOrphanedInvoices = vi
      .fn()
      .mockResolvedValue({ processedCount: 2, emittedEvents: ["i-1", "i-2"] });
    inner.reconcileExpiredPromises = vi
      .fn()
      .mockResolvedValue({ processedCount: 1, resolvedPromises: ["p-1"] });

    const result = await scheduler.runOnce();
    expect(result).toEqual({
      tenants: 2,
      orphanedInvoicesEmitted: 4,
      expiredPromisesResolved: 2,
    });
  });

  it("continues with remaining tenants when one tenant pass fails", async () => {
    const scheduler = new WorkerCronScheduler({
      listTenantIds: async () => ["bad-tenant", "good-tenant"],
    });
    const inner = (scheduler as unknown as { reconciler: unknown })
      .reconciler as {
      reconcileOrphanedInvoices: (tenantId: string) => Promise<unknown>;
      reconcileExpiredPromises: (tenantId: string) => Promise<unknown>;
    };
    inner.reconcileOrphanedInvoices = vi.fn(async (tenantId: string) => {
      if (tenantId === "bad-tenant") {
        throw new Error("tenant db down");
      }
      return { processedCount: 1, emittedEvents: ["i-9"] };
    });
    inner.reconcileExpiredPromises = vi
      .fn()
      .mockResolvedValue({ processedCount: 0, resolvedPromises: [] });

    const result = await scheduler.runOnce();
    expect(result.tenants).toBe(2);
    expect(result.orphanedInvoicesEmitted).toBe(1);
  });

  it("start() ticks on the configured cadence and stop() halts it", async () => {
    vi.useFakeTimers();
    const scheduler = new WorkerCronScheduler({
      listTenantIds: async () => [],
      reconcileIntervalMs: 5000,
    });
    const spy = vi.spyOn(scheduler, "runOnce");
    const stop = scheduler.start();
    try {
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(5000);
      expect(spy).toHaveBeenCalledTimes(2);
      stop();
      await vi.advanceTimersByTimeAsync(15000);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      spy.mockRestore();
    }
  });
});
