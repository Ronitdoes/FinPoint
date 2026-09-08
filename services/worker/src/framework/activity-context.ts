import { Context } from "@temporalio/activity";
import { db, withTransaction, type Database, type Tx } from "@repo/db";
import { getLogger, withSpan } from "@repo/observability";
import { checkFaultPoint } from "./fault-points";

export interface ActivityContext {
  tenantId: string;
  caseId: string;
  workflowId?: string;
  runId?: string;
  attempt?: number;
  actionId?: string;
  traceparent?: string;
}

const logger = getLogger({ component: "activity-framework" });

/**
 * Executes a callback with an isolated database transaction.
 * Guarantees that every activity opens its own DB transaction and NEVER runs
 * inside a caller's transaction (Spec 20 §Requirements 4).
 */
export async function withActivityDb<T>(
  ctx: ActivityContext,
  fn: (database: Database, tx?: Tx) => Promise<T>,
): Promise<T> {
  return await withTransaction({ db }, async (tx) => {
    return await fn(db, tx);
  });
}

/**
 * Runs an activity logic body within an OpenTelemetry span and structured logging context.
 */
export async function withActivityContext<T>(
  activityName: string,
  ctx: ActivityContext,
  fn: () => Promise<T>,
): Promise<T> {
  let attempt = ctx.attempt;
  try {
    const activityInfo = Context.current().info;
    attempt = activityInfo.attempt;
  } catch {
    // Context.current() is only available when running within a Temporal activity runner
  }

  const log = logger.child({
    activity: activityName,
    tenant_id: ctx.tenantId,
    case_id: ctx.caseId,
    workflow_id: ctx.workflowId,
    action_id: ctx.actionId,
    attempt,
  });

  return await withSpan(
    `activity.${activityName}`,
    {
      "recovery.case_id": ctx.caseId,
      "tenant.id": ctx.tenantId,
      "recovery.workflow_id": ctx.workflowId,
      "recovery.action_id": ctx.actionId,
    },
    async () => {
      log.debug({ activity: activityName }, "Starting activity execution");
      // Step 31: deterministic pre-hook breakpoint (fault-point harness).
      await checkFaultPoint(activityName, "pre", {
        tenantId: ctx.tenantId,
        caseId: ctx.caseId,
      });
      try {
        const result = await fn();
        // Step 31: deterministic post-hook breakpoint (fault-point harness).
        await checkFaultPoint(activityName, "post", {
          tenantId: ctx.tenantId,
          caseId: ctx.caseId,
        });
        log.debug({ activity: activityName }, "Activity executed successfully");
        return result;
      } catch (error) {
        log.error(
          { activity: activityName, err: error },
          "Activity execution failed",
        );
        throw error;
      }
    },
  );
}

/**
 * Sends a heartbeat to Temporal if running inside an active activity execution.
 */
export function sendActivityHeartbeat(...details: unknown[]): void {
  try {
    Context.current().heartbeat(...details);
  } catch {
    // Silently ignore when called outside of a Temporal worker context (e.g. unit tests)
  }
}
