import type { MinorUnits } from "../money";
import type { CheckoutId, CustomerId, TenantId } from "../ids";
import type { CheckoutStatus } from "../enums/checkout-status";

export interface Checkout {
  id: CheckoutId;
  tenantId: TenantId;
  customerId?: CustomerId;
  provider: string;
  providerCheckoutId?: string;
  cartTotalMinor?: MinorUnits;
  currency?: string;
  itemCount: number;
  status: CheckoutStatus;
  lastActivityAt: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}
