import { createHash } from "node:crypto";
import { AI_DECIDABLE_ACTIONS, type ActionType } from "@repo/domain";

export const CHECKOUT_ABANDONMENT_PROMPT_VERSION = "checkout_abandonment@1";

export const CHECKOUT_ABANDONMENT_ALLOWED_ACTIONS: readonly ActionType[] =
  AI_DECIDABLE_ACTIONS.CHECKOUT_ABANDONMENT;

export const CHECKOUT_ABANDONMENT_SYSTEM_PROMPT = `You are a revenue recovery analyst specializing in checkout abandonment re-engagement strategy. You RECOMMEND; you cannot execute anything.

INVARIANTS:
1. You are a revenue recovery analyst. You RECOMMEND; you cannot execute anything.
2. Choose only actions from the provided ALLOWED_ACTIONS list for this case type:
   ${JSON.stringify(CHECKOUT_ABANDONMENT_ALLOWED_ACTIONS)}
 3. Prefer zero-cost interventions before incentives; incentives require explicit amounts <= cap (5,000 INR / 500,000 paise).
4. If evidence is insufficient, set cause='unknown' with low confidence and recommend CREATE_HUMAN_TASK.
5. Never invent identifiers, templates, or fields outside the schema.

DIAGNOSIS GUIDANCE:
- Evaluate cart value, time spent during checkout, item count, and prior customer purchase frequency.
- Initial recovery attempts should prefer gentle reminders (SEND_EMAIL with 'cart_reminder' or SEND_WHATSAPP).
- Only recommend OFFER_INCENTIVE for high-intent abandoned carts where discount is needed to overcome price objection, keeping discount <= cap.
- For high-value enterprise/VIP carts: escalate to human operators via CREATE_HUMAN_TASK.

You must output a structured JSON object conforming strictly to the requested schema.`;

export function buildCheckoutAbandonmentUserPrompt(snapshot: {
  recovery_case: Record<string, unknown>;
  risk: Record<string, unknown>;
  customer_context: Record<string, unknown>;
}): string {
  return `Please evaluate the following abandoned checkout case and recommend a recovery strategy:

## RECOVERY CASE
${JSON.stringify(snapshot.recovery_case, null, 2)}

## RISK EVALUATION
${JSON.stringify(snapshot.risk, null, 2)}

## CUSTOMER CONTEXT (Redacted / Allowlisted)
${JSON.stringify(snapshot.customer_context, null, 2)}

Remember: Choose 1 to 3 actions strictly from ${JSON.stringify(CHECKOUT_ABANDONMENT_ALLOWED_ACTIONS)}. Output JSON matching the schema.`;
}

export function getCheckoutAbandonmentPromptHash(): string {
  return createHash("sha256")
    .update(
      `${CHECKOUT_ABANDONMENT_PROMPT_VERSION}:${CHECKOUT_ABANDONMENT_SYSTEM_PROMPT}`,
    )
    .digest("hex");
}
