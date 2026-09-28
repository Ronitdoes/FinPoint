import type { FastifyInstance } from "fastify";
import { ExecutingSweeper } from "./executing-sweeper";
import { AttributionSweeper } from "../modules/outcomes/attribution.sweeper";
import { CostCompletenessJob } from "../modules/outcomes/cost-completeness.job";
import { AuditRetentionJob } from "../modules/audit/retention.job";
import { KpiSnapshotJob } from "./kpi-snapshot";
import { InfraSampler } from "./infra-sampler";
import { scheduleCronJob } from "./scheduler";

export * from "./executing-sweeper";
export * from "./scheduler";
export * from "./kpi-snapshot";
export * from "./infra-sampler";

export interface ExecutingSweeperJobOptions {
  enabled: boolean;
  /** Sweep interval in ms (default 5 minutes). */
  intervalMs?: number;
  /** Age threshold in seconds for stuck EXECUTING rows. */
  stuckSeconds?: number;
}

export interface CronJobOptions {
  enabled: boolean;
  /** Tick interval in ms (job-specific default when omitted). */
  intervalMs?: number;
}

export interface AuditRetentionJobOptions extends CronJobOptions {
  retentionMonths?: number;
  dryRun?: boolean;
}

export interface JobsOptions {
  executingSweeper?: ExecutingSweeperJobOptions;
  /** Hourly attribution-window sweeper (s-26 job, s-33 schedule). */
  attributionSweeper?: CronJobOptions;
  /** Daily action-cost completeness audit (s-26 job, s-33 schedule). */
  costCompleteness?: CronJobOptions;
  /** Monthly audit-retention archive stub (s-25 job, s-33 schedule). */
  auditRetention?: AuditRetentionJobOptions;
  /** 5-minute business KPI snapshot → gauges + pushgateway (s-34, ADR-016). */
  kpiSnapshot?: CronJobOptions & {
    cohortLabel?: string;
    pushGatewayUrl?: string | null;
  };
  /** 60-second SLI gauge sampler: pool, DLQ, pollers, approvals (s-34). */
  infraSampler?: CronJobOptions;
}

declare module "fastify" {
  interface FastifyInstance {
    stopJobs?: () => void;
  }
}

/**
 * Registers background reconciliation jobs.
 *
 * Disabled by default (tests and library consumers opt in explicitly); the
 * production server entrypoint (`server.ts`) enables the full s-33 cron
 * inventory in every non-test environment. Every job is idempotent and
 * overlap-guarded (see scheduler.ts); timers are `unref`'d.
 *
 * Full inventory, owners, and production scheduler mapping live in
 * docs/deploy/crons.md.
 */
export function registerJobs(
  app: FastifyInstance,
  opts: JobsOptions = {},
): () => void {
  const stops: Array<() => void> = [];
  const jobOpts = opts.executingSweeper;

  if (jobOpts?.enabled) {
    const sweeper = new ExecutingSweeper(app.db, app.repos, app.config);
    stops.push(
      scheduleCronJob(app, {
        name: "executing-sweeper",
        intervalMs: jobOpts.intervalMs ?? 5 * 60 * 1000,
        runOnce: () =>
          sweeper.runSweep({ stuckSeconds: jobOpts.stuckSeconds }),
      }),
    );
  }

  if (opts.attributionSweeper?.enabled) {
    const sweeper = new AttributionSweeper(app.db, app.repos, (app as any).redisClient ?? null);
    const intervalMs = opts.attributionSweeper.intervalMs ?? 60 * 60 * 1000;
    stops.push(
      scheduleCronJob(app, {
        name: "attribution-sweeper",
        intervalMs,
        runOnce: () => sweeper.runSweep({}),
      }),
    );
  }

  if (opts.costCompleteness?.enabled) {
    const job = new CostCompletenessJob(app.db, app.repos);
    const intervalMs = opts.costCompleteness.intervalMs ?? 24 * 60 * 60 * 1000;
    stops.push(
      scheduleCronJob(app, {
        name: "cost-completeness",
        intervalMs,
        runOnce: () => job.runAudit({}),
      }),
    );
  }

  if (opts.auditRetention?.enabled) {
    const job = new AuditRetentionJob({ db: app.db });
    const intervalMs =
      opts.auditRetention.intervalMs ?? 30 * 24 * 60 * 60 * 1000;
    const { retentionMonths, dryRun } = opts.auditRetention;
    stops.push(
      scheduleCronJob(app, {
        name: "audit-retention",
        intervalMs,
        runOnce: () => job.run({ retentionMonths, dryRun }),
      }),
    );
  }

  if (opts.kpiSnapshot?.enabled) {
    const job = new KpiSnapshotJob({
      db: app.db,
      cohortLabel: opts.kpiSnapshot.cohortLabel ?? "staging",
      pushGatewayUrl: opts.kpiSnapshot.pushGatewayUrl ?? null,
      onLog: (level, msg, extra) => {
        (app.log[level] as (obj: unknown, m: string) => void)(
          { job: "kpi-snapshot", ...(typeof extra === "object" ? extra : {}) },
          msg,
        );
      },
    });
    const intervalMs = opts.kpiSnapshot.intervalMs ?? 5 * 60 * 1000;
    stops.push(
      scheduleCronJob(app, {
        name: "kpi-snapshot",
        intervalMs,
        runOnce: () => job.runOnce(),
      }),
    );
  }

  if (opts.infraSampler?.enabled) {
    const sampler = new InfraSampler({
      db: app.db,
      eventBus: (app as { eventBus?: unknown }).eventBus,
      temporalAddress: app.config.temporal.address,
      temporalNamespace: app.config.temporal.namespace,
      taskQueue: app.config.temporal.taskQueue,
      onLog: (level, msg, extra) => {
        (app.log[level] as (obj: unknown, m: string) => void)(
          { job: "infra-sampler", ...(typeof extra === "object" ? extra : {}) },
          msg,
        );
      },
    });
    const intervalMs = opts.infraSampler.intervalMs ?? 60 * 1000;
    stops.push(
      scheduleCronJob(app, {
        name: "infra-sampler",
        intervalMs,
        runOnce: () => sampler.runOnce(),
      }),
    );
  }

  const stop = () => {
    for (const stopOne of stops) {
      stopOne();
    }
  };

  app.decorate("stopJobs", stop);
  app.addHook("onClose", async () => {
    stop();
  });

  return stop;
}
