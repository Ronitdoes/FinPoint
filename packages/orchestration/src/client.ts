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
 */
export class DefaultWorkflowClient implements RecoveryWorkflowClient {
  constructor(private readonly db?: Database) {}

  /**
   * Idempotently starts recovery workflow for a given case.
   * Uses deterministic WorkflowId `recover:{caseId}` per Step 20 §Requirements 3.
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

    // 1. Idempotency check: see if a workflow already exists for this case
    const existing = await findWorkflowByCaseId(
      { db },
      { tenantId: input.tenantId, caseId: input.caseId },
    );

    if (existing) {
      return {
        workflowId: existing.id,
        temporalWorkflowId: existing.temporalWorkflowId,
        accepted: false,
      };
    }

    // 2. Persist initial RUNNING workflow row
    const runId = randomUUID();
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

    // 3. Record initial workflow event
    await recordWorkflowEvent(
      { db },
      {
        workflowRowId: created.id,
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
        workflowId: created.id,
        temporalWorkflowId,
      },
      "Recovery workflow successfully initiated",
    );

    return {
      workflowId: created.id,
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
