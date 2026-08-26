import type { WorkflowId, RecoveryCaseId, TenantId } from "../ids";

export interface Workflow {
  id: WorkflowId;
  tenantId: TenantId;
  caseId: RecoveryCaseId;
  workflowName: string;
  runId?: string;
  startedAt: string;
  finishedAt?: string;
}
