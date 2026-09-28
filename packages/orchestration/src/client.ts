import { randomUUID } from "node:crypto";
import type { Database } from "@repo/db";
import {
  createWorkflow,
  findWorkflowByCaseId,
  updateWorkflowStatus,
  recordWorkflowEvent,
} from "@repo/db";
import { workflowStartedTotal, getLogger } from "@repo/observability";
import type {
  CancelWorkflowInput,
  SignalWorkflowInput,
  StartWorkflowInput,
  StartWorkflowResult,
} from "./types";

const logger = getLogger({ component: "workflow-client" });

export interface RecoveryWorkflowClient {
  startRecoveryWorkflow(input: StartWorkflowInput): Promise<StartWorkflowResult>;
  signalCase(input: SignalWorkflowInput): Promise<void>;
  cancelWorkflow(input: CancelWorkflowInput): Promise<void>;
}

/**
 * Default Workflow Client for case orchestration (Spec 01 §13, Step 17, Step 20 client interface).
 * Idempotently manages workflow state and row persistence with deterministic temporal workflow ID `recover:{caseId}`.
 *
 * L1 unification note: this client is the offline-safe DB-row half of dispatch.
 * Live Temporal dispatch is owned by `@repo/worker` (`services/worker/src/client.ts`,
 * `recover:{caseId}` + `ALLOW_DUPLICATE_FAILED_ONLY`, ADR-005). The backend routes
 * through `LiveWorkflowClient` (`apps/backend/src/lib/live-workflow-client.ts`),
 * which delegates to the worker client when its module loads and falls back to
 * this class otherwise. This class MUST NOT import `@repo/worker` (declared
 * dependency cycle: worker already depends on orchestration) nor
 * `@temporalio/*` (keeps the offline/dev path native-free). The `recover:{caseId}`
 * constructor below intentionally duplicates the worker's `WORKFLOW_ID` helper
 * (which lives in workflow-isolated code importing `@temporalio/workflow` and
 * cannot be shared); keep the two in sync.
 */
export class DefaultWorkflowClient implements RecoveryWorkflowClient {
  constructor(private readonly db?: Database) {}

  /**
   * Idempotently starts recovery workflow for a given case.
   * Uses deterministic WorkflowId `recover:{caseId}` per Step 20 §Requirements 3.
   *
   * Idempotency semantics mirror the worker client: only a RUNNING row is a
   * fast-path duplicate (`accepted: false`). A row in any other status means a
   * prior execution finished/failed and is re-activated (status back to RUNNING
   * with a fresh runId, `accepted: true`) — matching Temporal's
   * `ALLOW_DUPLICATE_FAILED_ONLY` reuse policy instead of permanently
   * rejecting the case.
   */
  async startRecoveryWorkflow(
    input: StartWorkflowInput,
  ): Promise<StartWorkflowResult> {
    const db = input.db ?? this.db;
    const temporalWorkflowId = `recover:${input.caseId}`;

    if (!db) {
      // In-memory / mock mode when no db provided
      workflowStartedTotal.inc({ type: input.workflowType });
      return {
        workflowId: randomUUID(),
        temporalWorkflowId,
        accepted: true,
      };
    }

    // 1. Idempotency check: only a RUNNING row is a duplicate fast-path
    // (worker parity: services/worker/src/client.ts). A non-RUNNING row is a
    // finished/failed execution and is re-activated below.
    const existing = await findWorkflowByCaseId(
      { db },
      { tenantId: input.tenantId, caseId: input.caseId },
    );

    if (existing && existing.status === "RUNNING") {
      return {
        workflowId: existing.id,
        temporalWorkflowId: existing.temporalWorkflowId,
        accepted: false,
      };
    }

    // 2. Persist initial RUNNING workflow row, or re-activate a terminal row
    // via a guarded conditional write (CONVENTIONS §9: updateWorkflowStatus
    // carries the tenant/workflow guard).
    const runId = randomUUID();
    let workflowRowId: string;
    if (!existing) {
      const created = await createWorkflow(
        { db },
        {
          tenantId: input.tenantId,
          caseId: input.caseId,
          temporalWorkflowId,
          runId,
          type: input.workflowType,
          status: "RUNNING",
        },
      );
      workflowRowId = created.id;
    } else {
      await updateWorkflowStatus(
        { db },
        {
          tenantId: input.tenantId,
          workflowId: existing.id,
          status: "RUNNING",
          runId,
        },
      );
      workflowRowId = existing.id;
    }

    // 3. Record initial workflow event
    await recordWorkflowEvent(
      { db },
      {
        workflowRowId,
        type: "WORKFLOW_INITIATED",
        payload: {
          workflowType: input.workflowType,
          actionCount: input.actions.length,
          runId,
        },
      },
    );

    workflowStartedTotal.inc({ type: input.workflowType });

    logger.info(
      {
        tenantId: input.tenantId,
        caseId: input.caseId,
        workflowId: workflowRowId,
        temporalWorkflowId,
      },
      "Recovery workflow successfully initiated",
    );

    return {
      workflowId: workflowRowId,
      temporalWorkflowId,
      accepted: true,
    };
  }

  /**
   * Sends a signal to an active workflow for a recovery case.
   */
  async signalCase(input: SignalWorkflowInput): Promise<void> {
    const db = input.db ?? this.db;
    if (!db || !input.tenantId) {
      logger.info(
        { caseId: input.caseId, signal: input.signal, payload: input.payload },
        "Signal sent to workflow (stub)",
      );
      return;
    }

    const workflow = await findWorkflowByCaseId(
      { db },
      { tenantId: input.tenantId, caseId: input.caseId },
    );

    if (!workflow) {
      logger.warn(
        { caseId: input.caseId, signal: input.signal },
        "Cannot signal workflow: workflow record not found for case",
      );
      return;
    }

    await recordWorkflowEvent(
      { db },
      {
        workflowRowId: workflow.id,
        type: `SIGNAL_${input.signal.toUpperCase()}`,
        payload: input.payload ?? {},
      },
    );
  }

  /**
   * Cancels an active workflow.
   */
  async cancelWorkflow(input: CancelWorkflowInput): Promise<void> {
    const db = input.db ?? this.db;
    if (!db || !input.tenantId) {
      return;
    }

    const workflow = await findWorkflowByCaseId(
      { db },
      { tenantId: input.tenantId, caseId: input.caseId },
    );

    if (workflow && workflow.status === "RUNNING") {
      await updateWorkflowStatus(
        { db },
        {
          tenantId: input.tenantId,
          workflowId: workflow.id,
          status: "CANCELLED",
          closedAt: new Date(),
        },
      );

      await recordWorkflowEvent(
        { db },
        {
          workflowRowId: workflow.id,
          type: "WORKFLOW_CANCELLED",
          payload: { reason: input.reason },
        },
      );
    }
  }
}
