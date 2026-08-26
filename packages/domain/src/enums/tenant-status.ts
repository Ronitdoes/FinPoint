export const TENANT_STATUSES = ["ACTIVE", "SUSPENDED"] as const;

export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const TenantStatus = Object.freeze(
  Object.fromEntries(TENANT_STATUSES.map((value) => [value, value])),
) as Readonly<Record<TenantStatus, TenantStatus>>;
