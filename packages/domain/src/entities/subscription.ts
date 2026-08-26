import type { CustomerId, SubscriptionId, TenantId } from "../ids";

export interface Subscription {
  id: SubscriptionId;
  tenantId: TenantId;
  customerId: CustomerId;
  provider: string;
  providerSubscriptionId?: string;
  currentPeriodEnd?: string;
  cancelledAt?: string;
  createdAt: string;
  updatedAt: string;
}
