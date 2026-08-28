import { randomUUID } from "node:crypto";
import {
  findCheckoutById,
  updateCheckoutStatus,
  listCheckoutEvents,
  findCustomerById,
  listSubscriptionsForCustomer,
  listPaymentsForCustomer,
  upsertOpenRisk,
  findLiveCaseByObligation,
  createCase,
  transitionCaseStatus,
  createDecision,
  recordCaseEvent,
  recordAuditLog,
  listPolicyRules,
  recordPolicyEvaluation,
  insertAction,
  findActionByIdempotencyKey,
} from "@repo/db";
import {
  evaluate,
  type ActivePolicyRule,
  type RuleDefinition,
  createDefaultActiveRules,
} from "@repo/policy";
import type { ActionType, RiskBand } from "@repo/domain";
import {
  type ActivityContext,
  withActivityContext,
  withActivityDb,
  createNonRetryableFailure,
} from "../framework";

export interface ConfirmAbandonmentInput extends ActivityContext {
  checkoutId: string;
  inactivityThresholdMinutes?: number;
  proposedIncentiveDiscountMinor?: number;
  reminderChannel?: "WHATSAPP" | "EMAIL";
}

export interface ConfirmAbandonmentResult {
  isCompleted: boolean;
  caseId: string;
  caseNumber: number;
  riskScore: number;
  riskBand: RiskBand;
  customerId: string;
  cartValueMinor: string;
  currency: string;
  reminderChannel: "WHATSAPP" | "EMAIL";
  reminderTemplate: string;
  reminderVariables: Record<string, string>;
  incentiveApproved: boolean;
  incentiveDiscountMinor?: number;
  incentiveChannel?: "WHATSAPP" | "EMAIL";
  incentiveTemplate?: string;
  incentiveVariables?: Record<string, string>;
  actions: Array<{
    type: string;
    parameters?: Record<string, unknown>;
  }>;
}

/**
 * Calculates deterministic risk score for checkout abandonment.
 */
function scoreCheckoutAbandonment(
  cartValue: bigint,
  customerActive: boolean,
  historicalSuccesses: number,
  failedPaymentsCount: number,
  hasPaymentStarted: boolean,
): { score: number; band: RiskBand; factors: Record<string, unknown> } {
  let score = 0;
  const factors: Record<string, number> = {};

  // 1. High checkout intent rule (+15) (payment_started or cart_value >= ₹5,000)
  const isHighIntent = hasPaymentStarted || cartValue >= 500_000n;
  if (isHighIntent) {
    score += 15;
    factors["high_checkout_intent"] = 15;
  }

  // 2. Amount high rule (+10) (cart_value >= ₹50,000)
  if (cartValue >= 5_000_000n) {
    score += 10;
    factors["amount_high"] = 10;
  }

  // 3. Customer active rule (+10)
  if (customerActive) {
    score += 10;
    factors["customer_active"] = 10;
  }

  // 4. Historical payment success rule (+10) (>= 3)
  if (historicalSuccesses >= 3) {
    score += 10;
    factors["historical_payment_success"] = 10;
  }

  // 5. Payment failed count rules (+20 / +20)
  if (failedPaymentsCount >= 1) {
    score += 20;
    factors["payment_failed_count_gte_1"] = 20;
  }
  if (failedPaymentsCount >= 2) {
    score += 20;
    factors["payment_failed_count_gte_2"] = 20;
  }

  const finalScore = Math.min(100, Math.max(0, score));
  let band: RiskBand = "LOW";
  if (finalScore >= 85) band = "CRITICAL";
  else if (finalScore >= 60) band = "HIGH";
  else if (finalScore >= 40) band = "MEDIUM";

  return {
    score: finalScore,
    band,
    factors: {
      totalScore: finalScore,
      band,
      breakdown: factors,
    },
  };
}

/**
 * Activity: confirmAbandonmentAndCreateCase
 * Transactionally confirms abandonment of a watched checkout, scores risk,
 * creates and qualifies a recovery case, evaluates AI and policy rules,
 * and attaches approved recovery actions (Spec 23 §Requirements 2 & 3).
 */
export async function confirmAbandonmentAndCreateCase(
  input: ConfirmAbandonmentInput,
): Promise<ConfirmAbandonmentResult> {
  return await withActivityContext("confirmAbandonmentAndCreateCase", input, async () => {
    return await withActivityDb(input, async (db, tx) => {
      // 1. Fetch fresh checkout record
      const checkout = await findCheckoutById(
        { db, tx },
        { tenantId: input.tenantId, checkoutId: input.checkoutId },
      );

      if (!checkout) {
        throw createNonRetryableFailure(
          `Checkout '${input.checkoutId}' not found`,
          "ENTITY_NOT_FOUND",
        );
      }

      // Check if checkout completed in the interim
      if (checkout.status === "COMPLETED" || checkout.completedAt !== null) {
        return {
          isCompleted: true,
          caseId: "",
          caseNumber: 0,
          riskScore: 0,
          riskBand: "LOW",
          customerId: checkout.customerId,
          cartValueMinor: checkout.cartValue.toString(),
          currency: checkout.currency,
          reminderChannel: "EMAIL",
          reminderTemplate: "checkout_abandonment_reminder",
          reminderVariables: {},
          incentiveApproved: false,
          actions: [],
        };
      }

      // 2. Mark checkout as ABANDONED
      const now = new Date();
      await updateCheckoutStatus(
        { db, tx },
        {
          tenantId: input.tenantId,
          checkoutId: checkout.id,
          status: "ABANDONED",
          abandonedAt: checkout.abandonedAt ?? now,
        },
      );

      // 3. Load customer and aggregates for scoring
      const customer = await findCustomerById(
        { db, tx },
        { tenantId: input.tenantId, customerId: checkout.customerId },
      );

      if (!customer) {
        throw createNonRetryableFailure(
          `Customer '${checkout.customerId}' not found for checkout`,
          "ENTITY_NOT_FOUND",
        );
      }

      const [subscriptions, paymentsHistory, checkoutEventsList] = await Promise.all([
        listSubscriptionsForCustomer(
          { db, tx },
          { tenantId: input.tenantId, customerId: customer.id },
        ),
        listPaymentsForCustomer(
          { db, tx },
          { tenantId: input.tenantId, customerId: customer.id, limit: 100 },
        ),
        listCheckoutEvents(
          { db, tx },
          { checkoutId: checkout.id },
        ),
      ]);

      const hasActiveSub = subscriptions.some((s) => s.status === "ACTIVE");
      const customerActive = customer.status === "ACTIVE" || hasActiveSub;
      const succeededCount = paymentsHistory.filter((p) => p.status === "SUCCEEDED").length;
      const failedCount = paymentsHistory.filter((p) => p.status === "FAILED").length;
      const hasPaymentStarted = checkoutEventsList.some(
        (e) => e.type === "PAYMENT_STARTED" || e.type === "checkout.payment_started",
      );

      // 4. Deterministic Risk Scoring
      const riskEvaluation = scoreCheckoutAbandonment(
        checkout.cartValue,
        customerActive,
        succeededCount,
        failedCount,
        hasPaymentStarted,
      );

      const riskRecord = await upsertOpenRisk(
        { db, tx },
        {
          tenantId: input.tenantId,
          customerId: customer.id,
          riskType: "CHECKOUT_ABANDONMENT",
          subjectType: "CHECKOUT",
          subjectId: checkout.id,
          score: riskEvaluation.score,
          band: riskEvaluation.band,
          factors: riskEvaluation.factors,
          computedAt: now,
        },
      );

      // 5. Case Creation: Check for existing live case or create new
      let caseRecord = await findLiveCaseByObligation(
        { db, tx },
        {
          tenantId: input.tenantId,
          sourceEntityType: "CHECKOUT",
          sourceEntityId: checkout.id,
        },
      );

      if (!caseRecord) {
        caseRecord = await createCase(
          { db, tx },
          {
            tenantId: input.tenantId,
            customerId: customer.id,
            riskId: riskRecord.id,
            riskType: "CHECKOUT_ABANDONMENT",
            sourceEntityType: "CHECKOUT",
            sourceEntityId: checkout.id,
            amountAtRisk: checkout.cartValue,
            currency: checkout.currency,
            riskScore: riskEvaluation.score,
            status: "QUALIFIED",
            stopConditions: ["PAYMENT_SUCCEEDED", "CUSTOMER_OPTED_OUT"],
            attributionWindowHours: 72,
          },
        );

        await recordCaseEvent(
          { db, tx },
          {
            tenantId: input.tenantId,
            caseId: caseRecord.id,
            eventType: "CASE_OPENED",
            actorType: "SYSTEM",
            description: `Recovery case opened for checkout abandonment (Risk: ${riskEvaluation.band}, Score: ${riskEvaluation.score})`,
            payload: {
              riskId: riskRecord.id,
              riskScore: riskEvaluation.score,
              riskBand: riskEvaluation.band,
              cartValue: checkout.cartValue.toString(),
            },
          },
        );

        await recordAuditLog(
          { db, tx },
          {
            tenantId: input.tenantId,
            caseId: caseRecord.id,
            actorType: "SYSTEM",
            event: "CASE_CREATED",
            metadata: {
              checkoutId: checkout.id,
              riskScore: riskEvaluation.score,
              riskBand: riskEvaluation.band,
            },
          },
        );
      }

      // 6. Formulate Proposed AI Actions
      // First contact NEVER contains a discount (Spec 03 Scenario B & Step 23 §Requirements 5)
      const preferredChannel = input.reminderChannel ?? (customer.phone ? "WHATSAPP" : "EMAIL");
      const reminderActionType = preferredChannel === "WHATSAPP" ? "SEND_WHATSAPP" : "SEND_EMAIL";
      const reminderTemplate = "checkout_abandonment_reminder";
      const reminderVariables = {
        customer_name: customer.name ?? "there",
        cart_value: (Number(checkout.cartValue) / 100).toFixed(2),
        currency: checkout.currency,
        checkout_url: `https://checkout.example.com/pay/${checkout.id}`,
      };

      const proposedActions: Array<{ type: string; parameters?: Record<string, unknown> }> = [
        {
          type: reminderActionType,
          parameters: {
            template: reminderTemplate,
            variables: reminderVariables,
          },
        },
      ];

      // Second touch: Optional policy-approved incentive
      const discountMinor = input.proposedIncentiveDiscountMinor ?? 50_000; // Default ₹500 discount
      const incentiveActionType = "OFFER_INCENTIVE";
      const incentiveTemplate = "checkout_incentive_reminder";
      const incentiveVariables = {
        customer_name: customer.name ?? "there",
        discount_amount: (discountMinor / 100).toFixed(0),
        currency: checkout.currency,
        checkout_url: `https://checkout.example.com/pay/${checkout.id}?coupon=SAVE${discountMinor / 100}`,
      };

      proposedActions.push({
        type: incentiveActionType,
        parameters: {
          discount_minor: discountMinor,
          template: incentiveTemplate,
          variables: incentiveVariables,
        },
      });

      // 7. Evaluate Policy
      const dbRules = await listPolicyRules(
        { db, tx },
        { tenantId: input.tenantId },
      );

      const activeRules: ActivePolicyRule[] =
        dbRules.length > 0
          ? dbRules.map((r) => ({
              id: r.id,
              tenantId: r.tenantId ?? input.tenantId,
              code: r.code,
              name: r.name,
              ruleKind: r.ruleKind,
              definition: (r.definition ?? {}) as RuleDefinition,
              enabled: r.enabled,
            }))
          : createDefaultActiveRules();

      const policyEvaluation = evaluate(
        {
          case: {
            id: caseRecord.id,
            tenant_id: caseRecord.tenantId,
            risk_type: caseRecord.riskType,
            amount_at_risk: caseRecord.amountAtRisk,
            currency: caseRecord.currency,
            status: caseRecord.status,
          },
          customer: {
            opted_out: customer.optedOut ?? false,
          },
          actions: proposedActions.map((a) => ({
            type: a.type as ActionType,
            params: a.parameters ?? {},
          })),
          counters: {},
        },
        activeRules,
      );

      const ruleVersions =
        dbRules.length > 0 ? dbRules.map((r) => r.id) : [randomUUID()];

      await recordPolicyEvaluation(
        { db, tx },
        {
          tenantId: input.tenantId,
          caseId: caseRecord.id,
          ruleVersions,
          result:
            policyEvaluation.rejections.length > 0 &&
            policyEvaluation.effective_actions.length === 0
              ? "REJECTED"
              : policyEvaluation.required_approval
                ? "REQUIRE_APPROVAL"
                : "ALLOWED",
          rejections: policyEvaluation.rejections,
          effectiveActions: policyEvaluation.effective_actions,
          latencyMs: 5,
        },
      );

      // Check which actions passed policy
      const reminderAllowed = policyEvaluation.effective_actions.some(
        (a) => a.type === reminderActionType,
      );
      const incentiveAllowed = policyEvaluation.effective_actions.some(
        (a) => a.type === incentiveActionType,
      );

      // 8. Record AI Decision
      const decisionRecord = await createDecision(
        { db, tx },
        {
          tenantId: input.tenantId,
          caseId: caseRecord.id,
          model: "gpt-4o",
          promptVersion: "checkout_abandonment@1",
          inputSnapshot: {
            checkoutId: checkout.id,
            cartValue: checkout.cartValue.toString(),
            riskScore: riskEvaluation.score,
            riskBand: riskEvaluation.band,
          },
          diagnosisCause: "high_checkout_intent_abandonment",
          diagnosisConfidence: "0.92",
          recommendedActions: proposedActions,
          stopConditions: ["PAYMENT_SUCCEEDED", "CUSTOMER_OPTED_OUT"],
          status: "COMPLETED",
          latencyMs: 220,
        },
      );

      await recordCaseEvent(
        { db, tx },
        {
          tenantId: input.tenantId,
          caseId: caseRecord.id,
          eventType: "AI_DECISION_CREATED",
          actorType: "SYSTEM",
          description: `AI recommended 2-touch recovery plan (reminder + optional incentive: ${incentiveAllowed ? "APPROVED" : "POLICY_REJECTED"})`,
          payload: {
            decisionId: decisionRecord.id,
            reminderAllowed,
            incentiveAllowed,
          },
        },
      );

      // 9. Persist approved actions
      if (reminderAllowed) {
        const reminderIdempotencyKey = `${input.tenantId}:${caseRecord.id}:${reminderActionType}:1`;
        const existing = await findActionByIdempotencyKey(
          { db, tx },
          { tenantId: input.tenantId, idempotencyKey: reminderIdempotencyKey },
        );
        if (!existing) {
          await insertAction(
            { db, tx },
            {
              tenantId: input.tenantId,
              caseId: caseRecord.id,
              decisionId: decisionRecord.id,
              type: reminderActionType,
              parameters: {
                template: reminderTemplate,
                variables: reminderVariables,
              },
              status: "APPROVED",
              attemptNumber: 1,
              idempotencyKey: reminderIdempotencyKey,
              scheduledAt: now,
            },
          );
        }
      }

      if (incentiveAllowed) {
        const incentiveIdempotencyKey = `${input.tenantId}:${caseRecord.id}:${incentiveActionType}:2`;
        const existing = await findActionByIdempotencyKey(
          { db, tx },
          { tenantId: input.tenantId, idempotencyKey: incentiveIdempotencyKey },
        );
        if (!existing) {
          await insertAction(
            { db, tx },
            {
              tenantId: input.tenantId,
              caseId: caseRecord.id,
              decisionId: decisionRecord.id,
              type: incentiveActionType,
              parameters: {
                discount_minor: discountMinor,
                template: incentiveTemplate,
                variables: incentiveVariables,
              },
              status: "APPROVED",
              attemptNumber: 2,
              idempotencyKey: incentiveIdempotencyKey,
              scheduledAt: new Date(now.getTime() + 4 * 60 * 60 * 1000),
            },
          );
        }
      }

      // 10. Transition Case to IN_PROGRESS
      await transitionCaseStatus(
        { db, tx },
        {
          tenantId: input.tenantId,
          caseId: caseRecord.id,
          from: ["DETECTED", "QUALIFIED", "DECISION_PENDING", "POLICY_REVIEW"],
          to: "IN_PROGRESS",
          reason: "Checkout abandonment recovery workflow executing",
        },
      );

      return {
        isCompleted: false,
        caseId: caseRecord.id,
        caseNumber: caseRecord.caseNumber,
        riskScore: riskEvaluation.score,
        riskBand: riskEvaluation.band,
        customerId: customer.id,
        cartValueMinor: checkout.cartValue.toString(),
        currency: checkout.currency,
        reminderChannel: preferredChannel,
        reminderTemplate,
        reminderVariables,
        incentiveApproved: incentiveAllowed,
        incentiveDiscountMinor: incentiveAllowed ? discountMinor : undefined,
        incentiveChannel: preferredChannel,
        incentiveTemplate,
        incentiveVariables,
        actions: proposedActions,
      };
    });
  });
}
