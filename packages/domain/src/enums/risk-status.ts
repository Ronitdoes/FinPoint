export const RISK_STATUSES = ["OPEN", "ASSESSED", "EXPIRED"] as const;

export type RiskStatus = (typeof RISK_STATUSES)[number];

export const RiskStatus = Object.freeze(
  Object.fromEntries(RISK_STATUSES.map((value) => [value, value])),
) as Readonly<Record<RiskStatus, RiskStatus>>;
