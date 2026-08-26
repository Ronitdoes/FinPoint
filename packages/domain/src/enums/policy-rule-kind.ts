export const POLICY_RULE_KINDS = [
  "REJECT",
  "REQUIRE_APPROVAL",
  "LIMIT",
] as const;

export type PolicyRuleKind = (typeof POLICY_RULE_KINDS)[number];

export const PolicyRuleKind = Object.freeze(
  Object.fromEntries(POLICY_RULE_KINDS.map((value) => [value, value])),
) as Readonly<Record<PolicyRuleKind, PolicyRuleKind>>;
