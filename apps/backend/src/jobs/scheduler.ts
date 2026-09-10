import type { FastifyInstance } from "fastify";

/**
 * Overlap-guarded interval scheduler shared by backend background jobs
 * (s-33 cron inventory). Each tick runs `runOnce`; a tick that fires while
 * the previous run is still in flight is SKIPPED (never parallel), because
 * every job here is idempotent and a doubled tick must be harmless.
 *
 * Timers are `unref`'d so background passes never hold test runners or
 * graceful shutdown open. Returns a stop function; also wired to onClose.
 */
export function scheduleCronJob(
  app: FastifyInstance,
  opts: {
    name: string;
    intervalMs: number;
    runOnce: () => Promise<unknown>;
  },
): () => void {
  const { name, intervalMs, runOnce } = opts;
  let inFlight = false;

  const tick = async () => {
    if (inFlight) {
      app.log.warn({ job: name }, "cron tick skipped: previous run still in flight");
      return;
    }
    inFlight = true;
    try {
      const result = await runOnce();
      app.log.info({ job: name, result }, "cron tick completed");
    } catch (err) {
      app.log.error({ err, job: name }, "cron tick failed");
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  // Never hold the process open for a background reconciliation pass.
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  app.log.info({ job: name, intervalMs }, "cron job registered");

  return () => clearInterval(timer);
}
