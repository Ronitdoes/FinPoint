import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { activities, type RecoveryActivities } from "../activities";
import { DEFAULT_TASK_QUEUE } from "../workflows/shared";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface WorkflowTestSetup {
  testEnv: TestWorkflowEnvironment;
  worker: Worker;
  taskQueue: string;
}

/**
 * Creates an ephemeral test environment with time-skipping capabilities
 * and starts a worker instance with optional activity overrides (Spec 20 §Requirements 7).
 */
export async function createTestWorkflowEnvironment(
  activityOverrides: Partial<RecoveryActivities> = {},
): Promise<WorkflowTestSetup> {
  let testEnv: TestWorkflowEnvironment;

  try {
    testEnv = await TestWorkflowEnvironment.createTimeSkipping();
  } catch {
    // Fallback to local server connection on localhost:7233 if time-skipping native binary fails
    testEnv = await TestWorkflowEnvironment.createLocal({
      server: {
        port: 7233,
      },
    });
  }

  const { client, nativeConnection } = testEnv;
  const taskQueue = `test-${DEFAULT_TASK_QUEUE}-${Date.now()}`;
  const workflowsPath = path.resolve(__dirname, "../workflows/index.ts");

  const mergedActivities: RecoveryActivities = {
    ...activities,
    ...activityOverrides,
  };

  const worker = await Worker.create({
    connection: nativeConnection,
    namespace: client.options.namespace,
    taskQueue,
    workflowsPath,
    activities: mergedActivities,
  });

  return {
    testEnv,
    worker,
    taskQueue,
  };
}
