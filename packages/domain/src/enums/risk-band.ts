export const RISK_BANDS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

export type RiskBand = (typeof RISK_BANDS)[number];

export const RiskBand = Object.freeze(
  Object.fromEntries(RISK_BANDS.map((value) => [value, value])),
) as Readonly<Record<RiskBand, RiskBand>>;
