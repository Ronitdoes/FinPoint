export const POLICY_RESULTS = [
  "ALLOWED",
  "REJECTED",
  "REQUIRE_APPROVAL",
] as const;

export type PolicyResult = (typeof POLICY_RESULTS)[number];

export const PolicyResult = Object.freeze(
  Object.fromEntries(POLICY_RESULTS.map((value) => [value, value])),
) as Readonly<Record<PolicyResult, PolicyResult>>;
