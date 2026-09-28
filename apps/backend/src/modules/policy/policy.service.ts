import {
  evaluate,
  DEFAULT_POLICY_RULES,
  type ActivePolicyRule,
  type PolicyInput,
} from "@repo/policy";
import {
  policyEvaluationsTotal,
  policyEvaluationDurationMs,
  policyRejectionsTotal,
} from "@repo/observability";
import type { Database } from "@repo/db";
import { isUniqueViolation, withTransaction } from "@repo/db";
import type { ActorType } from "@repo/domain";
import type { Repositories } from "../../plugins/db";
import {
  CaseNotFoundError,
  ConcurrentVersionError,
  PolicyEvaluationFailedError,
  PolicyNotFoundError,
  ValidationError,
} from "../../lib/errors";
import { DatabaseCounterFetcher } from "./counters";
import type {
  CreatePolicyRuleBody,
  EvaluatePolicyRequest,
  EvaluatePolicyResponse,
  UpdatePolicyRuleBody,
} from "./policy.types";

export interface ActorContext {
  userId?: string;
  role?: string;
  actorType?: ActorType;
}

export class PolicyService {
  private readonly counterFetcher: DatabaseCounterFetcher;

  constructor(
    private readonly db: Database,
    private readonly repos: Repositories,
  ) {
    this.counterFetcher = new DatabaseCounterFetcher(db, repos);
  }

  /**
   * Evaluates proposed actions against all active policy rules (Spec 01 §11, Step 16).
   * Guarantees Fail-Closed behavior on any internal failure.
   */
  async evaluatePolicy(
    tenantId: string,
    request: EvaluatePolicyRequest,
    _actor?: ActorContext,
  ): Promise<EvaluatePolicyResponse> {
    const startTime = performance.now();
    const caseId = request.case_id || request.caseId;

    if (!caseId) {
      throw new ValidationError("case_id is required for policy evaluation");
    }

    try {
      // 1. Resolve recovery case
      const recoveryCase = await this.repos.findCaseById(
        { db: this.db },
        { tenantId, caseId },
      );

      if (!recoveryCase) {
        throw new CaseNotFoundError(`Recovery case '${caseId}' not found`);
      }

      // 2. Resolve customer
      const customer = await this.repos.findCustomerById(
        { db: this.db },
        { tenantId, customerId: recoveryCase.customerId },
      );

      // 3. Resolve real-time counters
      const counters = await this.counterFetcher.getCounters({
        tenantId,
        customerId: recoveryCase.customerId,
        caseId,
      });

      // 3b. Derive retry_count + payment_status from the case-linked payment
      // (s-16 audit G1: previously never fed, leaving POL-MAXRETRY dead and
      // POL-PAYMENT-SUCCESS half-dead). Source of truth: payments.status plus
      // COUNT(payment_attempts) for the payment referenced by
      // (source_entity_type=PAYMENT, source_entity_id). Non-payment cases keep
      // retry_count=0 / payment_status="" — the case status alone still drives
      // POL-PAYMENT-SUCCESS via RECOVERED/RESOLVED_UPSTREAM. DB errors here
      // propagate to the fail-closed handler below (never fail open).
      let retryCount = 0;
      let paymentStatus = "";
      if (
        recoveryCase.sourceEntityType === "PAYMENT" &&
        recoveryCase.sourceEntityId
      ) {
        const linkedPayment = await this.repos.findPaymentById(
          { db: this.db },
          { tenantId, paymentId: recoveryCase.sourceEntityId },
        );
        if (linkedPayment) {
          paymentStatus = linkedPayment.status ?? "";
          const attempts =
            await this.repos.findPaymentAttemptsByPaymentId(
              { db: this.db },
              { tenantId, paymentId: linkedPayment.id },
            );
          retryCount = attempts.length;
        }
      }

      // 4. Resolve AI decision if linked
      const decisionId = request.decision_id || request.decisionId;
      let decisionRow: any = null;
      if (decisionId) {
        decisionRow = await this.repos.findDecisionById(
          { db: this.db },
          { tenantId, decisionId },
        );
      }

      // 5. Load active policy rules & versions (tenant rules + platform defaults).
      // s-16 audit: latest versions are batch-loaded in ONE query instead of
      // N× getLatestPolicyVersion round trips (see getLatestPolicyVersionsForRules).
      const allRules = await this.repos.listPolicyRules(
        { db: this.db },
        { tenantId },
      );

      const enabledRules = allRules.filter((rule) => rule.enabled);
      const latestByRuleId =
        await this.repos.getLatestPolicyVersionsForRules(
          { db: this.db },
          { ruleIds: enabledRules.map((rule) => rule.id) },
        );

      const activeRulesWithVersions: ActivePolicyRule[] = [];
      const versionIds: string[] = [];

      for (const rule of enabledRules) {
        const latestVersion = latestByRuleId.get(rule.id);

        if (latestVersion) {
          versionIds.push(latestVersion.id);
        }

        activeRulesWithVersions.push({
          id: rule.id,
          tenantId: rule.tenantId,
          code: rule.code,
          name: rule.name,
          description: rule.description,
          ruleKind: rule.ruleKind,
          definition: rule.definition as any,
          enabled: rule.enabled,
          activeVersionId: latestVersion?.id,
          activeVersionNumber: latestVersion?.version ?? 1,
        });
      }

      // 6. Build PolicyInput
      const policyInput: PolicyInput = {
        case: {
          id: recoveryCase.id,
          tenant_id: recoveryCase.tenantId,
          risk_type: recoveryCase.riskType,
          amount_at_risk: Number(recoveryCase.amountAtRisk),
          currency: recoveryCase.currency,
          risk_score: recoveryCase.riskScore,
          retry_count: retryCount,
          payment_status: paymentStatus,
          status: recoveryCase.status,
          stop_conditions: recoveryCase.stopConditions,
        },
        customer: {
          opted_out: customer?.optedOut ?? false,
          dispute_open: (customer as any)?.disputeOpen ?? false,
        },
        decision: decisionRow
          ? {
              diagnosis_confidence: decisionRow.diagnosisConfidence,
              requires_approval: decisionRow.requiresApproval ?? false,
              diagnosis: decisionRow.diagnosis,
              actions: decisionRow.recommendedActions,
            }
          : null,
        actions: request.actions,
        counters,
        policy_version_ids: versionIds,
        options: request.overrides as any,
      };

      // 7. Pure deterministic evaluation
      const result = evaluate(policyInput, activeRulesWithVersions);
      const latencyMs = Math.max(1, Math.round(performance.now() - startTime));

      // 8. Persist append-only evaluation audit log
      const evaluationRecord = await this.repos.recordPolicyEvaluation(
        { db: this.db },
        {
          tenantId,
          caseId,
          decisionId: decisionRow ? decisionRow.id : undefined,
          ruleVersions: result.rule_versions ?? versionIds,
          result: result.result,
          rejections: result.rejections,
          effectiveActions: result.effective_actions,
          latencyMs,
        },
      );

      // 9. Observability metrics
      policyEvaluationsTotal.inc({ result: result.result.toLowerCase() });
      policyEvaluationDurationMs.observe({ rule_set: "default" }, latencyMs);

      for (const rej of result.rejections) {
        policyRejectionsTotal.inc({
          rule_code: rej.rule_code,
          reason: rej.reason,
        });
      }

      return {
        evaluationId: evaluationRecord.id,
        allowed: result.allowed,
        required_approval: result.required_approval,
        result: result.result,
        rejections: result.rejections,
        effective_actions: result.effective_actions,
        applied_rules: result.applied_rules,
        rule_versions: result.rule_versions,
        latency_ms: latencyMs,
      };
    } catch (error: any) {
      if (error instanceof CaseNotFoundError || error instanceof ValidationError) {
        throw error;
      }
      // Fail-closed guarantee
      throw new PolicyEvaluationFailedError(
        `Policy evaluation failed: ${error?.message || "Internal failure"}`,
        { originalError: error?.message },
      );
    }
  }

  /**
   * Lists all policy rules visible to tenant with their latest version.
   */
  async listPolicies(tenantId: string) {
    const rules = await this.repos.listPolicyRules({ db: this.db }, { tenantId });
    // s-16 audit: single batch query for latest versions (was N× round trips).
    const latestByRuleId = await this.repos.getLatestPolicyVersionsForRules(
      { db: this.db },
      { ruleIds: rules.map((rule) => rule.id) },
    );
    return rules.map((rule) => {
      const latestVersion = latestByRuleId.get(rule.id);
      return {
        ...rule,
        activeVersion: latestVersion?.version ?? 1,
        activeVersionId: latestVersion?.id,
        snapshot: latestVersion?.snapshot ?? rule.definition,
      };
    });
  }

  /**
   * Creates a tenant-scoped custom policy rule and its initial version snapshot.
   * Runs inside ONE transaction (CONVENTIONS §9, s-16 fix): rule + version-1 +
   * audit are atomic, so a crash can never leave a rule without history.
   */
  async createPolicyRule(
    tenantId: string,
    body: CreatePolicyRuleBody,
    actor?: ActorContext,
  ) {
    const ruleKind = (body.ruleKind || body.rule_kind || "REJECT") as any;

    return withTransaction({ db: this.db }, async (tx) => {
      const txCtx = { tx };
      const createdRule = await this.repos.createPolicyRule(
        txCtx,
        {
          tenantId,
          code: body.code,
          name: body.name,
          description: body.description,
          ruleKind,
          definition: body.definition,
          enabled: body.enabled ?? true,
        },
      );

      const version = await this.repos.createPolicyVersion(
        txCtx,
        {
          ruleId: createdRule.id,
          version: 1,
          snapshot: body.definition,
          createdBy: actor?.userId,
        },
      );

      await this.repos.recordAuditLog(
        txCtx,
        {
          tenantId,
          actorType: actor?.actorType || "USER",
          actorId: actor?.userId,
          event: "POLICY_RULE_CREATED",
          metadata: {
            ruleId: createdRule.id,
            code: createdRule.code,
            version: 1,
          },
        },
      );

      return {
        ...createdRule,
        activeVersion: version.version,
        activeVersionId: version.id,
      };
    });
  }

  /**
   * Updates an existing policy rule and creates an immutable snapshot version.
   *
   * s-16 audit: the rule update + version insert + audit write run inside ONE
   * explicit transaction (CONVENTIONS §9) so a crash can never leave a rule
   * row ahead of its snapshot history. Optimistic concurrency implements the
   * contracted 409 CONCURRENT_VERSION: callers may pass expected_version; a
   * stale expectation — or a lost version-number race (23505) — fails with
   * ConcurrentVersionError instead of forking version history.
   */
  async updatePolicyRule(
    tenantId: string,
    ruleId: string,
    body: UpdatePolicyRuleBody,
    actor?: ActorContext,
  ) {
    const existingRule = await this.repos.findPolicyRuleById(
      { db: this.db },
      { ruleId },
    );

    if (!existingRule) {
      throw new PolicyNotFoundError(`Policy rule '${ruleId}' not found`);
    }

    // Tenant rules must match tenantId; platform defaults (tenantId = null) can only be updated if no tenantId restriction
    if (existingRule.tenantId && existingRule.tenantId !== tenantId) {
      throw new PolicyNotFoundError(`Policy rule '${ruleId}' not found`);
    }

    const latestVersion = await this.repos.getLatestPolicyVersion(
      { db: this.db },
      { ruleId },
    );

    const expectedVersion =
      (body as { expected_version?: number }).expected_version ??
      (body as { expectedVersion?: number }).expectedVersion;
    if (
      expectedVersion !== undefined &&
      latestVersion &&
      expectedVersion !== latestVersion.version
    ) {
      throw new ConcurrentVersionError(
        `Policy rule '${ruleId}' was modified concurrently: expected version ${expectedVersion}, current version is ${latestVersion.version}`,
        { ruleId, expectedVersion, currentVersion: latestVersion.version },
      );
    }

    const nextVersion = (latestVersion?.version ?? 0) + 1;

    return await withTransaction({ db: this.db }, async (tx) => {
      const updatedRule = await this.repos.updatePolicyRule(
        { tx },
        {
          ruleId,
          tenantId: existingRule.tenantId ?? undefined,
          name: body.name,
          description: body.description,
          definition: body.definition,
          enabled: body.enabled,
        },
      );

      const snapshot = body.definition ?? (updatedRule?.definition || existingRule.definition);

      let version;
      try {
        version = await this.repos.createPolicyVersion(
          { tx },
          {
            ruleId,
            version: nextVersion,
            snapshot: snapshot as Record<string, unknown>,
            createdBy: actor?.userId,
          },
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConcurrentVersionError(
            `Policy rule '${ruleId}' was modified concurrently (version ${nextVersion} already exists)`,
            { ruleId, nextVersion },
          );
        }
        throw error;
      }

      await this.repos.recordAuditLog(
        { tx },
        {
          tenantId,
          actorType: actor?.actorType || "USER",
          actorId: actor?.userId,
          event: "POLICY_RULE_UPDATED",
          metadata: {
            ruleId,
            version: nextVersion,
            changes: body,
          },
        },
      );

      return {
        ...updatedRule,
        activeVersion: version.version,
        activeVersionId: version.id,
      };
    });
  }

  /**
   * Retrieves version history for a policy rule.
   */
  async listPolicyVersions(tenantId: string, ruleId: string) {
    const rule = await this.repos.findPolicyRuleById(
      { db: this.db },
      { ruleId },
    );

    if (!rule) {
      throw new PolicyNotFoundError(`Policy rule '${ruleId}' not found`);
    }

    if (rule.tenantId && rule.tenantId !== tenantId) {
      throw new PolicyNotFoundError(`Policy rule '${ruleId}' not found`);
    }

    return await this.repos.listPolicyVersions({ db: this.db }, { ruleId });
  }

  /**
   * Seeds the 9 default rules into the database (idempotent).
   */
  async seedDefaultPolicies() {
    let created = 0;
    let existing = 0;
    let versionsCreated = 0;

    const foundRules: { id: string; definition: unknown }[] = [];

    for (const def of DEFAULT_POLICY_RULES) {
      const found = await this.repos.findPolicyRuleByCode(
        { db: this.db },
        { code: def.code },
      );

      if (!found) {
        const rule = await this.repos.createPolicyRule(
          { db: this.db },
          {
            tenantId: null,
            code: def.code,
            name: def.name,
            description: def.description,
            ruleKind: def.ruleKind,
            definition: def.definition,
            enabled: def.enabled,
          },
        );
        created++;

        await this.repos.createPolicyVersion(
          { db: this.db },
          {
            ruleId: rule.id,
            version: 1,
            snapshot: def.definition,
          },
        );
        versionsCreated++;
      } else {
        existing++;
        foundRules.push(found);
      }
    }

    // s-16 audit: verify missing version-1 snapshots in ONE batch query
    // (startup-only path; was N× getLatestPolicyVersion round trips).
    if (foundRules.length > 0) {
      const latestByRuleId =
        await this.repos.getLatestPolicyVersionsForRules(
          { db: this.db },
          { ruleIds: foundRules.map((r) => r.id) },
        );
      for (const found of foundRules) {
        if (!latestByRuleId.has(found.id)) {
          await this.repos.createPolicyVersion(
            { db: this.db },
            {
              ruleId: found.id,
              version: 1,
              snapshot: found.definition as Record<string, unknown>,
            },
          );
          versionsCreated++;
        }
      }
    }

    return { created, existing, versionsCreated };
  }
}
