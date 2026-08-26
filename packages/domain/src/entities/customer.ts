import type { CustomerId, TenantId } from "../ids";

export interface Customer {
  id: CustomerId;
  tenantId: TenantId;
  externalId?: string;
  name?: string;
  email?: string;
  phone?: string;
  timezone?: string;
  optedOut: boolean;
  createdAt: string;
  updatedAt: string;
}
