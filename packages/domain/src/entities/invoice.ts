import type { MinorUnits } from "../money";
import type { CustomerId, InvoiceId, TenantId } from "../ids";
import type { InvoiceStatus } from "../enums/invoice-status";

export interface Invoice {
  id: InvoiceId;
  tenantId: TenantId;
  customerId: CustomerId;
  invoiceNumber?: string;
  amountMinor: MinorUnits;
  currency: string;
  status: InvoiceStatus;
  dueAt?: string;
  paidAt?: string;
  createdAt: string;
  updatedAt: string;
}
