export const RECOVERY_COST_CATEGORIES = [
  "LLM",
  "MESSAGING",
  "PAYMENT_PROCESSING",
  "DISCOUNT",
  "MANUAL_HANDLING",
  "PROVIDER",
] as const;

export type RecoveryCostCategory = (typeof RECOVERY_COST_CATEGORIES)[number];

export const RecoveryCostCategory = Object.freeze(
  Object.fromEntries(RECOVERY_COST_CATEGORIES.map((value) => [value, value])),
) as Readonly<Record<RecoveryCostCategory, RecoveryCostCategory>>;
