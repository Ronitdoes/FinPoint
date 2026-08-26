import type { PolicyRuleId, TenantId } from "../ids";

export const POLICY_EFFECTS = ["ALLOW", "REJECT", "REQUIRE_APPROVAL"] as const;

export type PolicyEffect = (typeof POLICY_EFFECTS)[number];

export interface Policy {
  id: PolicyRuleId;
  tenantId: TenantId;
  key: string;
  version: number;
  effect: PolicyEffect;
  condition: Record<string, unknown>;
  active: boolean;
  createdAt: string;
}
