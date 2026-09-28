import {
  setApprovalOldestAge,
  setBusConsumerLag,
  setBusDlqDepth,
  setDbPoolStats,
  setTemporalWorkerStats,
  incHumanTasksOpen,
} from "@repo/observability";
import { listPendingHumanTasks, listTenants, type Database } from "@repo/db";

/**
 * Infrastructure sampler job (s-34).
 *
 * Every 60s this job refreshes the SLI gauges that Prometheus cannot derive
 * from counters alone:
 *   - `db_pool_*` — pool checkout counts sampled from the pg driver
 *   - `bus_dlq_depth{group="all"}` — true parked-message count for the
 *     in-process driver (`getDlqMessages()`); for Redpanda the depth comes
 *     from the DLQ topic offsets (staging exporter) and the
 *     `increase(bus_dlq_total)` arm of the BusDLQDepth alert covers routing
 *   - `temporal_worker_pollers{queue}` — observed pollers via
 *     `DescribeTaskQueue`; ANY observation failure reports 0, because an
 *     unobservable queue is indistinguishable from a halted one (the
 *     runbook disambiguates server-down vs worker-gone)
 *   - `human_tasks_open` / `approval_oldest_age_seconds` — approval queue
 *     depth and head-of-line age across tenants (AI dashboard)
 *
 * Every probe is injectable and failure-isolated: one failing probe never
 * aborts the remaining gauges (same policy as the s-33 cron inventory).
 */

export const INFRA_SAMPLER_INTERVAL_MS = 60 * 1000;
export const TEMPORAL_TASK_QUEUE = "recovery-main";

export interface QueueStats {
  pollers: number;
  freeSlots: number;
}

export interface ApprovalStats {
  openByType: Record<string, number>;
  oldestAgeSeconds: number;
}

export interface InfraSamplerDeps {
  db?: Database;
  eventBus?: unknown;
  temporalAddress?: string;
  temporalNamespace?: string;
  taskQueue?: string;
  probeDbPool?: () => { used: number; max: number } | null;
  probeBusDlqDepth?: () => number | null;
  probeBusLagSeconds?: () => number | null;
  probeQueueStats?: () => Promise<QueueStats | null>;
  probeApprovalStats?: () => Promise<ApprovalStats | null>;
  onLog?: (level: "info" | "warn" | "error", msg: string, extra?: unknown) => void;
}

export interface InfraSamplerRunResult {
  dbPool: { used: number; max: number } | null;
  dlqDepth: number | null;
  queue: QueueStats;
  approvals: ApprovalStats | null;
}

/** Pure saturation helper (also unit-tested). */
export function computeSaturation(used: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(1, Math.max(0, used / max));
}

/**
 * Best-effort pg pool introspection across driver shapes (postgres-js,
 * node-postgres Pool, drizzle wrappers). Returns null when the pool shape
 * is unrecognized — the caller then leaves the previous gauge value alone.
 */
export function probeDbPoolFromDriver(db: unknown): { used: number; max: number } | null {
  try {
    const anyDb = db as Record<string, any> | null | undefined;
    if (!anyDb || typeof anyDb !== "object") return null;
    const candidates = [
      anyDb.pool,
      anyDb.session?.client?.pool,
      anyDb.client?.pool,
      anyDb._?.session?.client?.pool,
    ];
    for (const pool of candidates) {
      if (!pool || typeof pool !== "object") continue;
      const total =
        pool.totalCount ?? pool.total ?? pool.size ?? pool.maxSize ?? null;
      const idle =
        pool.idleCount ?? pool.idle ?? pool.available ?? 0;
      const waiting = pool.waitingCount ?? pool.waiting ?? 0;
      if (typeof total === "number" && total > 0) {
        const used = Math.max(0, total - (typeof idle === "number" ? idle : 0));
        const max =
          typeof pool.max === "number" && pool.max > 0
            ? pool.max
            : typeof pool.options?.max === "number"
              ? pool.options.max
              : total + (typeof waiting === "number" ? waiting : 0);
        return { used, max: Math.max(total, max) };
      }
      const maxOnly =
        (typeof pool.max === "number" && pool.max > 0 ? pool.max : null) ??
        (typeof pool.options?.max === "number" ? pool.options.max : null);
      if (maxOnly) return { used: 0, max: maxOnly };
    }
    return null;
  } catch {
    return null;
  }
}

export class InfraSampler {
  private readonly deps: InfraSamplerDeps;

  constructor(deps: InfraSamplerDeps = {}) {
    this.deps = deps;
  }

  async runOnce(): Promise<InfraSamplerRunResult> {
    const { db, eventBus, onLog } = this.deps;
    const log = onLog ?? (() => {});
    const taskQueue = this.deps.taskQueue ?? TEMPORAL_TASK_QUEUE;

    // 1. DB pool.
    let dbPool: { used: number; max: number } | null = null;
    try {
      const probe = this.deps.probeDbPool ?? (() => (db ? probeDbPoolFromDriver(db) : null));
      dbPool = probe();
      if (dbPool) setDbPoolStats(dbPool.used, dbPool.max);
    } catch (err) {
      log("warn", "infra-sampler db pool probe failed", { err });
    }

    // 2. Bus DLQ depth (in-process driver exposes true parked count).
    let dlqDepth: number | null = null;
    try {
      const probe =
        this.deps.probeBusDlqDepth ??
        (() => {
          const bus = eventBus as { getDlqMessages?: () => unknown[] } | null;
          if (bus && typeof bus.getDlqMessages === "function") {
            return bus.getDlqMessages().length;
          }
          return null;
        });
      dlqDepth = probe();
      if (dlqDepth !== null) setBusDlqDepth("all", dlqDepth);
      const lagProbe = this.deps.probeBusLagSeconds;
      if (lagProbe) {
        const lag = lagProbe();
        if (lag !== null) setBusConsumerLag("all", lag);
      }
    } catch (err) {
      log("warn", "infra-sampler bus probe failed", { err });
    }

    // 3. Temporal queue pollers (real observation; failure ⇒ 0 ⇒ page).
    let queue: QueueStats = { pollers: 0, freeSlots: 0 };
    try {
      const probe = this.deps.probeQueueStats ?? (() => this.describeQueue(taskQueue));
      const observed = await probe();
      queue = observed ?? { pollers: 0, freeSlots: 0 };
    } catch {
      queue = { pollers: 0, freeSlots: 0 };
    }
    try {
      setTemporalWorkerStats(taskQueue, queue.pollers, queue.freeSlots);
    } catch (err) {
      log("warn", "infra-sampler temporal gauge write failed", { err });
    }

    // 4. Approval queue depth + head-of-line age.
    let approvals: ApprovalStats | null = null;
    try {
      const probe = this.deps.probeApprovalStats ?? (() => this.sampleApprovals(db));
      approvals = await probe();
      if (approvals) {
        for (const [type, count] of Object.entries(approvals.openByType)) {
          incHumanTasksOpen(type, 0); // ensure series exists
          const { humanTasksOpen } = await import("@repo/observability");
          humanTasksOpen.set({ type }, count);
        }
        setApprovalOldestAge(approvals.oldestAgeSeconds);
      }
    } catch (err) {
      log("warn", "infra-sampler approval probe failed", { err });
    }

    log("info", "infra-sampler pass completed", {
      dbPool,
      dlqDepth,
      queue,
      approvals,
    });
    return { dbPool, dlqDepth, queue, approvals };
  }

  /** Default queue probe: real `DescribeTaskQueue` poller count; 0 on any failure. */
  private async describeQueue(taskQueue: string): Promise<QueueStats> {
    try {
      // NOTE (s-35): import the "./client" subpath, not the package root:
      // the root re-exports registry/worker which drag @temporalio/worker's
      // webpack chain into `bun build` of the backend image (loader-utils).
      const { getTemporalClient } = await import("@repo/worker/client");
      const client = await getTemporalClient(this.deps.temporalAddress);
      const resp = (await (client as any).workflowService.describeTaskQueue({
        namespace: this.deps.temporalNamespace ?? "revenue-recovery",
        taskQueue: { name: taskQueue },
        taskQueueType: 1,
      })) as { pollers?: unknown[] };
      const pollers = Array.isArray(resp?.pollers) ? resp.pollers.length : 0;
      // freeSlots has no cheap server-side signal; report pollers as the
      // liveness floor (documented; slot pressure reads come from Temporal UI
      // until a dedicated worker exporter lands — see runbook).
      return { pollers, freeSlots: pollers };
    } catch {
      return { pollers: 0, freeSlots: 0 };
    }
  }

  /** Default approval probe: per-tenant PENDING tasks (bounded pages). */
  private async sampleApprovals(db: Database | undefined): Promise<ApprovalStats> {
    const openByType: Record<string, number> = {};
    let oldestAgeSeconds = 0;
    const now = Date.now();
    const limit = 100;
    let offset = 0;
    for (;;) {
      const tenants = await listTenants({ db }, { limit, offset });
      if (tenants.length === 0) break;
      for (const tenant of tenants) {
        // Bounded single page per tenant per pass (sampler, not audit).
        const pending = await listPendingHumanTasks(
          { db },
          { tenantId: tenant.id, limit: 200 },
        );
        for (const task of pending) {
          const type = (task as { type?: string }).type ?? "APPROVAL";
          openByType[type] = (openByType[type] ?? 0) + 1;
          const created = new Date((task as { createdAt: string | Date }).createdAt).getTime();
          if (!Number.isNaN(created)) {
            oldestAgeSeconds = Math.max(oldestAgeSeconds, (now - created) / 1000);
          }
        }
      }
      if (tenants.length < limit) break;
      offset += limit;
    }
    return { openByType, oldestAgeSeconds: Math.round(oldestAgeSeconds) };
  }
}
