import { listTenants, type Database } from "@repo/db";
import type { EventBus } from "@repo/integrations";
import { getLogger } from "@repo/observability";
import { DailyReconciler } from "./reconciler";

const logger = getLogger({ component: "worker-cron" });

export interface WorkerCronSchedulerOptions {
  db?: Database;
  eventBus?: EventBus;
  /** Daily reconciler cadence in ms (default 24h). */
  reconcileIntervalMs?: number;
  /** Tenant enumeration (injectable for tests; defaults to paged listTenants). */
  listTenantIds?: () => Promise<string[]>;
}

export interface WorkerCronRunResult {
  tenants: number;
  orphanedInvoicesEmitted: number;
  expiredPromisesResolved: number;
}

async function defaultListTenantIds(db?: Database): Promise<string[]> {
  const ids: string[] = [];
  const limit = 100;
  let offset = 0;
  for (;;) {
    const page = await listTenants({ db }, { limit, offset });
    for (const tenant of page) {
      ids.push(tenant.id);
    }
    if (page.length < limit) {
      return ids;
    }
    offset += limit;
  }
}

/**
 * Worker-process cron module (s-33, docs/deploy/crons.md).
 *
 * Runs the DailyReconciler (orphaned OVERDUE invoices + expired promises to
 * pay) across every tenant on a fixed cadence. Ticks are overlap-guarded —
 * a tick that fires while the previous pass is still running is skipped —
 * and per-tenant failures are logged without aborting the pass. Both
 * reconciler methods are idempotent, so a missed or repeated pass is safe.
 *
 * The timer is `unref`'d so background passes never hold test runners or
 * graceful shutdown open.
 */
export class WorkerCronScheduler {
  private readonly reconciler: DailyReconciler;
  private readonly reconcileIntervalMs: number;
  private readonly listTenantIds: () => Promise<string[]>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(opts: WorkerCronSchedulerOptions = {}) {
    this.reconciler = new DailyReconciler({
      db: opts.db,
      eventBus: opts.eventBus,
    });
    this.reconcileIntervalMs =
      opts.reconcileIntervalMs ?? 24 * 60 * 60 * 1000;
    this.listTenantIds =
      opts.listTenantIds ?? (() => defaultListTenantIds(opts.db));
  }

  public async runOnce(): Promise<WorkerCronRunResult> {
    const tenantIds = await this.listTenantIds();
    let orphanedInvoicesEmitted = 0;
    let expiredPromisesResolved = 0;

    for (const tenantId of tenantIds) {
      try {
        const orphaned =
          await this.reconciler.reconcileOrphanedInvoices(tenantId);
        const expired =
          await this.reconciler.reconcileExpiredPromises(tenantId);
        orphanedInvoicesEmitted += orphaned.processedCount;
        expiredPromisesResolved += expired.processedCount;
      } catch (err) {
        logger.error(
          { tenantId, err },
          "worker-cron tenant pass failed; continuing with remaining tenants",
        );
      }
    }

    const result = {
      tenants: tenantIds.length,
      orphanedInvoicesEmitted,
      expiredPromisesResolved,
    };
    logger.info(result, "worker-cron reconciler pass completed");
    return result;
  }

  public start(): () => void {
    if (this.timer) {
      return () => this.stop();
    }
    logger.info(
      { reconcileIntervalMs: this.reconcileIntervalMs },
      "worker-cron scheduler started",
    );
    this.timer = setInterval(() => {
      void this.tick();
    }, this.reconcileIntervalMs);
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
    return () => this.stop();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.inFlight) {
      logger.warn("worker-cron tick skipped: previous pass still in flight");
      return;
    }
    this.inFlight = true;
    try {
      await this.runOnce();
    } catch (err) {
      logger.error({ err }, "worker-cron tick failed");
    } finally {
      this.inFlight = false;
    }
  }
}
