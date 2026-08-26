import type {
  RecoveryActionId,
  RecoveryCaseId,
  TenantId,
} from "../ids";
import type { ActionType } from "../enums/action-type";
import type { ActorType } from "../enums/actor-type";

export interface RecoveryAction {
  id: RecoveryActionId;
  tenantId: TenantId;
  caseId: RecoveryCaseId;
  type: ActionType;
  parameters: unknown;
  actorType: ActorType;
  idempotencyKey: string;
  requestedAt: string;
  executedAt?: string;
  failureReason?: string;
}
