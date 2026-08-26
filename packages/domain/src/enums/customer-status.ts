export const CUSTOMER_STATUSES = [
  "ACTIVE",
  "CHURNED",
  "BLOCKED",
] as const;

export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

export const CustomerStatus = Object.freeze(
  Object.fromEntries(CUSTOMER_STATUSES.map((value) => [value, value])),
) as Readonly<Record<CustomerStatus, CustomerStatus>>;
