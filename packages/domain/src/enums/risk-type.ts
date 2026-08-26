export const RISK_TYPES = [
  "PAYMENT_FAILURE",
  "CHECKOUT_ABANDONMENT",
  "INVOICE_OVERDUE",
] as const;

export type RiskType = (typeof RISK_TYPES)[number];

export const RiskType = Object.freeze(
  Object.fromEntries(RISK_TYPES.map((value) => [value, value])),
) as Readonly<Record<RiskType, RiskType>>;
