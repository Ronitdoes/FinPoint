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
/**
 * Upper bound for a single timer delay. Runtimes store the delay as a
 * signed 32-bit int — anything larger overflows and fires ~every millisecond
 * (e.g. the 30-day audit-retention default of 2,592,000,000 ms). Jobs needing
 * a longer period must tick more often and skip when not due (see
 * audit-retention in ./index.ts), never pass a larger delay here.
 */
export const MAX_INTERVAL_MS = 2_147_483_647;

export function scheduleCronJob(
  app: FastifyInstance,
  opts: {
    name: string;
    intervalMs: number;
    runOnce: () => Promise<unknown>;
  },
): () => void {
  let { name, intervalMs, runOnce } = opts;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(
      `scheduleCronJob(${name}): intervalMs must be a positive finite number, got ${intervalMs}`,
    );
  }
  if (intervalMs > MAX_INTERVAL_MS) {
    app.log.warn(
      { job: name, intervalMs, maxIntervalMs: MAX_INTERVAL_MS },
      "cron interval exceeds runtime timer limit, clamping — use a shorter tick with a due-date guard instead",
    );
    intervalMs = MAX_INTERVAL_MS;
  }
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
