import type { HumanTaskPriority } from "../actions/catalog";
import type {
  HumanTaskId,
  RecoveryCaseId,
  TenantId,
} from "../ids";

export interface HumanTask {
  id: HumanTaskId;
  tenantId: TenantId;
  caseId: RecoveryCaseId;
  taskType: string;
  title: string;
  description: string;
  priority: HumanTaskPriority;
  resolvedBy?: string;
  resolutionNotes?: string;
  resolvedAt?: string;
  createdAt: string;
}
