import type { ActorType } from "../enums/actor-type";
import type {
  AuditLogId,
  RecoveryCaseId,
  TenantId,
} from "../ids";

export interface AuditLogEntry {
  id: AuditLogId;
  sequence: number;
  tenantId: TenantId;
  caseId?: RecoveryCaseId;
  actorType: ActorType;
  actorId?: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
