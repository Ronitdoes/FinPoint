import type {
  AiDecisionId,
  RecoveryCaseId,
  TenantId,
} from "../ids";
import type { ActionType } from "../enums/action-type";
import type { StopCondition } from "../enums/stop-condition";

export interface AiDiagnosis {
  cause: string;
  confidence: number;
}

export interface AiProposedAction {
  type: ActionType;
  parameters: unknown;
  rationale?: string;
}

export interface AiDecision {
  id: AiDecisionId;
  tenantId: TenantId;
  caseId: RecoveryCaseId;
  model: string;
  diagnosis: AiDiagnosis;
  proposedActions: AiProposedAction[];
  stopConditions: StopCondition[];
  promptHash: string;
  rawResponse?: string;
  createdAt: string;
}
