import type { MinorUnits } from "../money";
import type {
  CustomerId,
  RecoveryCaseId,
  TenantId,
} from "../ids";
import type { CaseStatus } from "../enums/case-status";
import type { RiskBand } from "../enums/risk-band";
import type { RiskType } from "../enums/risk-type";
import type { StopCondition } from "../enums/stop-condition";

export interface RecoveryCase {
  id: RecoveryCaseId;
  caseNumber?: string;
  tenantId: TenantId;
  customerId: CustomerId;
  riskType: RiskType;
  riskBand: RiskBand;
  status: CaseStatus;
  amountAtRiskMinor: MinorUnits;
  currency: string;
  stopCondition?: StopCondition;
  escalatedAt?: string;
  recoveredAt?: string;
  stoppedAt?: string;
  createdAt: string;
  updatedAt: string;
}
