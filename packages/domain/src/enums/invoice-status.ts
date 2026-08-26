export const INVOICE_STATUSES = [
  "DRAFT",
  "SENT",
  "DUE",
  "OVERDUE",
  "PAID",
  "DISPUTED",
  "CANCELLED",
] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const InvoiceStatus = Object.freeze(
  Object.fromEntries(INVOICE_STATUSES.map((value) => [value, value])),
) as Readonly<Record<InvoiceStatus, InvoiceStatus>>;
