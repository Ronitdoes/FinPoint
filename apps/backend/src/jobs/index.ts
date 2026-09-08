import type { FastifyInstance } from "fastify";
import { ExecutingSweeper } from "./executing-sweeper";

export * from "./executing-sweeper";

export interface ExecutingSweeperJobOptions {
  enabled: boolean;
  /** Sweep interval in ms (default 5 minutes). */
  intervalMs?: number;
  /** Age threshold in seconds for stuck EXECUTING rows. */
  stuckSeconds?: number;
}

export interface JobsOptions {
  executingSweeper?: ExecutingSweeperJobOptions;
}

declare module "fastify" {
  interface FastifyInstance {
    stopJobs?: () => void;
  }
}

/**
 * Registers background reconciliation jobs (Step 31 §Technical Implementation).
 *
 * Disabled by default (tests and library consumers opt in explicitly); the
 * production server entrypoint (`server.ts`) enables the EXECUTING-stuck
 * sweeper on a 5-minute interval. Timers are `unref`'d so they never hold
 * test runners or graceful shutdown open.
 */
export function registerJobs(
  app: FastifyInstance,
  opts: JobsOptions = {},
): () => void {
  const timers: Array<ReturnType<typeof setInterval>> = [];
  const jobOpts = opts.executingSweeper;

  if (jobOpts?.enabled) {
    const intervalMs = jobOpts.intervalMs ?? 5 * 60 * 1000;
    const sweeper = new ExecutingSweeper(app.db, app.repos, app.config);

    const runOnce = async () => {
      try {
        await sweeper.runSweep({ stuckSeconds: jobOpts.stuckSeconds });
      } catch (err) {
        app.log.error({ err }, "executing-sweeper background pass failed");
      }
    };

    const timer = setInterval(() => {
      void runOnce();
    }, intervalMs);
    // Never hold the process open for a background reconciliation pass.
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    timers.push(timer);
    app.log.info(
      { intervalMs },
      "executing-sweeper background job registered",
    );
  }

  const stop = () => {
    for (const timer of timers) {
      clearInterval(timer);
    }
  };

  app.decorate("stopJobs", stop);
  app.addHook("onClose", async () => {
    stop();
  });

  return stop;
}
