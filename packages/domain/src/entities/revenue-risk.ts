import type {
  RecoveryCaseId,
  RevenueRiskId,
  TenantId,
} from "../ids";
import type { RiskBand } from "../enums/risk-band";
import type { RiskType } from "../enums/risk-type";

export interface RevenueRisk {
  id: RevenueRiskId;
  tenantId: TenantId;
  caseId?: RecoveryCaseId;
  riskType: RiskType;
  riskBand: RiskBand;
  riskScore: number;
  signals: Record<string, number>;
  detectedAt: string;
}
