import { z } from "zod";
import type { PolicyEvaluationResult, PolicyRejection, EffectiveAction, OverallPolicyResult } from "@repo/policy";

export const ActionProposalInputSchema = z.object({
  type: z.string().min(1),
  params: z.record(z.unknown()).default({}),
});

export const EvaluatePolicyRequestSchema = z.object({
  case_id: z.string().uuid().optional(),
  caseId: z.string().uuid().optional(),
  decision_id: z.string().uuid().optional(),
  decisionId: z.string().uuid().optional(),
  actions: z.array(ActionProposalInputSchema).min(1),
  overrides: z.record(z.unknown()).optional(),
});

export type EvaluatePolicyRequest = z.infer<typeof EvaluatePolicyRequestSchema>;

export const CreatePolicyRuleSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  ruleKind: z.enum(["REJECT", "REQUIRE_APPROVAL", "LIMIT"]).optional(),
  rule_kind: z.enum(["REJECT", "REQUIRE_APPROVAL", "LIMIT"]).optional(),
  definition: z.record(z.unknown()),
  enabled: z.boolean().default(true),
});

export type CreatePolicyRuleBody = z.infer<typeof CreatePolicyRuleSchema>;

export const UpdatePolicyRuleSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  definition: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
  // Optimistic concurrency token implementing the contracted 409
  // CONCURRENT_VERSION (s-16 audit): when supplied, the update is rejected
  // if the rule's current version differs.
  expected_version: z.number().int().positive().optional(),
  expectedVersion: z.number().int().positive().optional(),
});

export type UpdatePolicyRuleBody = z.infer<typeof UpdatePolicyRuleSchema>;

export interface EvaluatePolicyResponse {
  evaluationId: string;
  allowed: boolean;
  required_approval: boolean;
  result: OverallPolicyResult;
  rejections: PolicyRejection[];
  effective_actions: EffectiveAction[];
  applied_rules?: string[];
  rule_versions?: string[];
  latency_ms: number;
}
