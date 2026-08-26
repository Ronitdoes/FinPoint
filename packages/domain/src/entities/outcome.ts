import type {
  RecoveryOutcomeId,
  RecoveryCaseId,
  TenantId,
} from "../ids";
import type { MinorUnits } from "../money";

export interface CostBreakdown {
  llmCostMinor: MinorUnits;
  messagingCostMinor: MinorUnits;
  paymentProcessingCostMinor: MinorUnits;
  discountCostMinor: MinorUnits;
  humanHandlingCostMinor: MinorUnits;
  providerCostMinor: MinorUnits;
}

export interface RecoveryOutcome {
  id: RecoveryOutcomeId;
  tenantId: TenantId;
  caseId: RecoveryCaseId;
  recoveredAmountMinor: MinorUnits;
  netRecoveredMinor: MinorUnits;
  costs: CostBreakdown;
  attributionExpiresAt?: string;
  recordedAt: string;
}
