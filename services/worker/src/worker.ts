import { fileURLToPath } from "node:url";
import path from "node:path";
import { Worker, NativeConnection } from "@temporalio/worker";
import { workerConfig } from "@repo/config";
import { getLogger } from "@repo/observability";
import { ACTIVITIES } from "./registry";
import { DEFAULT_TASK_QUEUE } from "./workflows/shared";
import { WorkerCronScheduler } from "./cron/scheduler";

const logger = getLogger({ component: "recovery-worker" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runWorker(): Promise<void> {
  const config = workerConfig();
  const address = config.temporal.address ?? "localhost:7233";
  const namespace = config.temporal.namespace ?? "revenue-recovery";
  const taskQueue = DEFAULT_TASK_QUEUE;

  logger.info({ address, namespace, taskQueue }, "Connecting worker to Temporal server...");

  const connection = await NativeConnection.connect({
    address,
  });

  const workflowsPath = path.resolve(__dirname, "./workflows/index.ts");

  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    workflowsPath,
    activities: ACTIVITIES,
    maxConcurrentActivityTaskExecutions: 50,
  });

  logger.info(
    { namespace, taskQueue },
    "Recovery Temporal Worker started successfully and polling for tasks",
  );

  // s-33 cron module: daily invoice/PTP reconciler pass. Disabled in test
  // and when CRON_ENABLED=false; the timer is unref'd and stopped here so
  // worker drain (preStop sleep + poller shutdown) never hangs on cron.
  let stopCron: (() => void) | null = null;
  if (config.cron.enabled && config.app.env !== "test") {
    const scheduler = new WorkerCronScheduler({
      reconcileIntervalMs: config.cron.reconcileIntervalMs,
    });
    stopCron = scheduler.start();
  }

  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info({ signal }, "Gracefully shutting down worker; draining in-flight activities...");
    try {
      stopCron?.();
      worker.shutdown();
      await connection.close();
      logger.info("Worker shutdown complete");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "Error during worker shutdown");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await worker.run();
}

// Run directly when executed as entrypoint
if (
  process.argv[1] &&
  (process.argv[1].endsWith("worker.ts") || process.argv[1].endsWith("worker.js"))
) {
  runWorker().catch((err) => {
    logger.fatal({ err }, "Fatal error during worker runtime");
    process.exit(1);
  });
}
