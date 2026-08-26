import type { MinorUnits } from "../money";
import type { CustomerId, PaymentAttemptId, PaymentId, TenantId } from "../ids";
import type { PaymentStatus } from "../enums/payment-status";

export interface Payment {
  id: PaymentId;
  tenantId: TenantId;
  customerId: CustomerId;
  provider: string;
  providerPaymentId?: string;
  amountMinor: MinorUnits;
  currency: string;
  status: PaymentStatus;
  retryCount: number;
  capturedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentAttempt {
  id: PaymentAttemptId;
  tenantId: TenantId;
  paymentId: PaymentId;
  provider: string;
  providerAttemptId?: string;
  amountMinor: MinorUnits;
  currency: string;
  status: PaymentStatus;
  attemptedAt: string;
}
