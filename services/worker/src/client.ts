import { randomUUID } from "node:crypto";
import { Connection, Client, WorkflowIdReusePolicy } from "@temporalio/client";
import { workerConfig } from "@repo/config";
import {
  db,
  createWorkflow,
  findWorkflowByCaseId,
  updateWorkflowStatus,
  recordWorkflowEvent,
  type Database,
} from "@repo/db";
import { workflowStartedTotal, getLogger } from "@repo/observability";
import { WORKFLOW_ID, DEFAULT_TASK_QUEUE } from "./workflows/shared";

const logger = getLogger({ component: "temporal-client" });

let globalConnection: Connection | null = null;
let globalClient: Client | null = null;

export interface StartWorkflowInput {
  tenantId: string;
  caseId: string;
  workflowType: string;
  actions?: Array<{ type: string; parameters?: Record<string, unknown> }>;
  paymentId?: string;
  checkoutId?: string;
  invoiceId?: string;
  customerId?: string;
  amountMinor?: string;
  currency?: string;
  traceparent?: string;
  metadata?: Record<string, unknown>;
  db?: Database;
}

export interface StartWorkflowResult {
  workflowId: string;
  temporalWorkflowId: string;
  runId?: string;
  accepted: boolean;
}

export interface SignalWorkflowInput {
  tenantId: string;
  caseId: string;
  signal: string;
  payload?: unknown;
  db?: Database;
}

export interface CancelWorkflowInput {
  tenantId: string;
  caseId: string;
  reason?: string;
  db?: Database;
}

/**
 * Resolves or initializes the shared Temporal Client singleton.
 */
export async function getTemporalClient(customAddress?: string): Promise<Client> {
  if (globalClient) {
    return globalClient;
  }

  const config = workerConfig();
  const address = customAddress ?? config.temporal.address ?? "localhost:7233";
  const namespace = config.temporal.namespace ?? "revenue-recovery";

  try {
    globalConnection = await Connection.connect({ address });
    globalClient = new Client({
      connection: globalConnection,
      namespace,
    });
    logger.info({ address, namespace }, "Connected to Temporal server");
    return globalClient;
  } catch (error) {
    logger.error({ address, namespace, err: error }, "Failed to connect to Temporal server");
    throw error;
  }
}

/**
 * Resets the cached Temporal Client instance (useful for testing).
 */
export function resetTemporalClient(): void {
  globalConnection = null;
  globalClient = null;
}

/**
 * Idempotently starts a recovery workflow for a given case.
 * Enforces deterministic WorkflowId `recover:{caseId}` and ALLOW_DUPLICATE_FAILED_ONLY reuse policy.
 * (Spec 01 §13, Spec 20 §Requirements 3 & 5).
 */
export async function startRecoveryWorkflow(
  input: StartWorkflowInput,
): Promise<StartWorkflowResult> {
  const targetDb = input.db ?? db;
  const temporalWorkflowId = WORKFLOW_ID(input.caseId);

  // 1. Idempotency check: see if a workflow record already exists for this case
  const existing = await findWorkflowByCaseId(
    { db: targetDb },
    { tenantId: input.tenantId, caseId: input.caseId },
  );

  if (existing && existing.status === "RUNNING") {
    logger.info(
      { caseId: input.caseId, workflowId: existing.id, temporalWorkflowId },
      "Workflow is already running for case",
    );
    return {
      workflowId: existing.id,
      temporalWorkflowId: existing.temporalWorkflowId,
      runId: existing.runId ?? undefined,
      accepted: false,
    };
  }

  let client: Client | null = null;
  try {
    client = await getTemporalClient();
  } catch {
    logger.warn("Temporal client not available; continuing in fallback mode");
  }

  const runId = randomUUID();
  let workflowRowId = existing?.id;

  // 2. Persist or update workflow row in DB
  if (!workflowRowId) {
    const created = await createWorkflow(
      { db: targetDb },
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
      { db: targetDb },
      {
        tenantId: input.tenantId,
        workflowId: workflowRowId,
        status: "RUNNING",
        runId,
      },
    );
  }

  // 3. Dispatch to Temporal server if client is active
  if (client) {
    try {
      const handle = await client.workflow.start(input.workflowType, {
        workflowId: temporalWorkflowId,
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowIdReusePolicy:
          WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
        args: [
          {
            tenantId: input.tenantId,
            caseId: input.caseId,
            workflowType: input.workflowType,
            paymentId: input.paymentId,
            checkoutId: input.checkoutId,
            invoiceId: input.invoiceId,
            customerId: input.customerId,
            amountMinor: input.amountMinor,
            currency: input.currency,
            traceparent: input.traceparent,
            metadata: input.metadata,
          },
        ],
      });

      // Update runId with the actual Temporal execution run ID
      await updateWorkflowStatus(
        { db: targetDb },
        {
          tenantId: input.tenantId,
          workflowId: workflowRowId,
          status: "RUNNING",
          runId: handle.firstExecutionRunId,
        },
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "WorkflowExecutionAlreadyStartedError") {
        logger.info(
          { temporalWorkflowId },
          "Workflow execution already active in Temporal",
        );
        return {
          workflowId: workflowRowId,
          temporalWorkflowId,
          accepted: false,
        };
      }
      logger.error({ err, temporalWorkflowId }, "Failed to start Temporal workflow execution");
    }
  }

  // 4. Record audit event
  await recordWorkflowEvent(
    { db: targetDb },
    {
      workflowRowId,
      type: "WORKFLOW_INITIATED",
      payload: {
        workflowType: input.workflowType,
        temporalWorkflowId,
        runId,
      },
    },
  );

  workflowStartedTotal.inc({ type: input.workflowType });

  return {
    workflowId: workflowRowId,
    temporalWorkflowId,
    runId,
    accepted: true,
  };
}

/**
 * Signals an active recovery workflow.
 */
export async function signalCase(
  input: SignalWorkflowInput,
): Promise<void> {
  const targetDb = input.db ?? db;
  const temporalWorkflowId = WORKFLOW_ID(input.caseId);

  let client: Client | null = null;
  try {
    client = await getTemporalClient();
  } catch {
    // Non-blocking if Temporal server is offline
  }

  if (client) {
    try {
      const handle = client.workflow.getHandle(temporalWorkflowId);
      await handle.signal(input.signal, input.payload);
      logger.info(
        { caseId: input.caseId, signal: input.signal },
        "Signal sent to Temporal workflow",
      );
    } catch (err) {
      logger.warn(
        { caseId: input.caseId, signal: input.signal, err },
        "Failed to signal Temporal workflow instance",
      );
    }
  }

  // Record signal in DB workflow event ledger
  const workflow = await findWorkflowByCaseId(
    { db: targetDb },
    { tenantId: input.tenantId, caseId: input.caseId },
  );

  if (workflow) {
    await recordWorkflowEvent(
      { db: targetDb },
      {
        workflowRowId: workflow.id,
        type: `SIGNAL_${input.signal.toUpperCase()}`,
        payload: (input.payload as Record<string, unknown>) ?? {},
      },
    );
  }
}

/**
 * Cancels an active recovery workflow.
 */
export async function cancelWorkflow(
  input: CancelWorkflowInput,
): Promise<void> {
  const targetDb = input.db ?? db;
  const temporalWorkflowId = WORKFLOW_ID(input.caseId);

  let client: Client | null = null;
  try {
    client = await getTemporalClient();
  } catch {
    // Non-blocking
  }

  if (client) {
    try {
      const handle = client.workflow.getHandle(temporalWorkflowId);
      await handle.cancel();
      logger.info({ caseId: input.caseId }, "Cancelled Temporal workflow");
    } catch (err) {
      logger.warn({ caseId: input.caseId, err }, "Failed to cancel Temporal workflow");
    }
  }

  const workflow = await findWorkflowByCaseId(
    { db: targetDb },
    { tenantId: input.tenantId, caseId: input.caseId },
  );

  if (workflow && workflow.status === "RUNNING") {
    await updateWorkflowStatus(
      { db: targetDb },
      {
        tenantId: input.tenantId,
        workflowId: workflow.id,
        status: "CANCELLED",
        closedAt: new Date(),
      },
    );

    await recordWorkflowEvent(
      { db: targetDb },
      {
        workflowRowId: workflow.id,
        type: "WORKFLOW_CANCELLED",
        payload: { reason: input.reason },
      },
    );
  }
}
