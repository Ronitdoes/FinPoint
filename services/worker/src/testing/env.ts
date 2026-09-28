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
  // Retry time-skipping: parallel vitest files can collide starting the
  // Java test server. Fall back to an ISOLATED local test server on an
  // ephemeral port — never :7233, which belongs to the real compose
  // Temporal (it has no `default` namespace, so every workflow start
  // fails with NamespaceNotFound).
  let testEnv: TestWorkflowEnvironment | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      testEnv = await TestWorkflowEnvironment.createTimeSkipping();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  if (!testEnv) {
    // Real-time server: long-timer tests will hang. Warn loudly instead of
    // failing minutes later with an opaque timeout (cf. Sep-17 audit).
    console.warn(
      "[worker-tests] time-skipping test server unavailable; using real-time local server",
    );
    testEnv = await TestWorkflowEnvironment.createLocal();
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
