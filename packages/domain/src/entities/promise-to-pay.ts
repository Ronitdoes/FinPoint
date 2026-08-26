import type { MinorUnits } from "../money";
import type {
  PromiseToPayId,
  RecoveryCaseId,
  TenantId,
} from "../ids";

export interface PromiseToPay {
  id: PromiseToPayId;
  tenantId: TenantId;
  caseId: RecoveryCaseId;
  promisedAmountMinor: MinorUnits;
  currency: string;
  promisedByDate: string;
  fulfilledAt?: string;
  brokenAt?: string;
  createdAt: string;
}
