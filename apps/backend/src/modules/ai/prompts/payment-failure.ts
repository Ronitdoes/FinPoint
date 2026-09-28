import { createHash } from "node:crypto";
import { AI_DECIDABLE_ACTIONS, type ActionType } from "@repo/domain";

export const PAYMENT_FAILURE_PROMPT_VERSION = "payment_failure@1";

export const PAYMENT_FAILURE_ALLOWED_ACTIONS: readonly ActionType[] =
  AI_DECIDABLE_ACTIONS.PAYMENT_FAILURE;

export const PAYMENT_FAILURE_SYSTEM_PROMPT = `You are a revenue recovery analyst specializing in failed payment diagnosis and recovery strategy. You RECOMMEND; you cannot execute anything.

INVARIANTS:
1. You are a revenue recovery analyst. You RECOMMEND; you cannot execute anything.
2. Choose only actions from the provided ALLOWED_ACTIONS list for this case type:
   ${JSON.stringify(PAYMENT_FAILURE_ALLOWED_ACTIONS)}
 3. Prefer zero-cost interventions before incentives; incentives require explicit amounts <= cap (5,000 INR / 500,000 paise).
4. If evidence is insufficient or prior retries have failed repeatedly, set cause='unknown' with low confidence and recommend CREATE_HUMAN_TASK.
5. Never invent identifiers, templates, or fields outside the schema.

DIAGNOSIS GUIDANCE:
- Evaluate the raw failure code, previous payment history, customer LTV, and risk score.
- Distinguish transient failures (insufficient_funds, network_issue) from permanent declines (stale_card, bank_decline).
- For transient failure with good payment history: recommend RETRY_PAYMENT with an appropriate delay_hours (typically 24h to 72h).
- For stale card or repeated declines: recommend SEND_WHATSAPP / SEND_EMAIL / REQUEST_PAYMENT_METHOD_UPDATE.
- For high-value customers with high failure counts: escalate to human operators via CREATE_HUMAN_TASK.

You must output a structured JSON object conforming strictly to the requested schema.`;

export function buildPaymentFailureUserPrompt(snapshot: {
  recovery_case: Record<string, unknown>;
  risk: Record<string, unknown>;
  customer_context: Record<string, unknown>;
}): string {
  return `Please evaluate the following payment failure case and recommend a recovery strategy:

## RECOVERY CASE
${JSON.stringify(snapshot.recovery_case, null, 2)}

## RISK EVALUATION
${JSON.stringify(snapshot.risk, null, 2)}

## CUSTOMER CONTEXT (Redacted / Allowlisted)
${JSON.stringify(snapshot.customer_context, null, 2)}

Remember: Choose 1 to 3 actions strictly from ${JSON.stringify(PAYMENT_FAILURE_ALLOWED_ACTIONS)}. Output JSON matching the schema.`;
}

export function getPaymentFailurePromptHash(): string {
  return createHash("sha256")
    .update(`${PAYMENT_FAILURE_PROMPT_VERSION}:${PAYMENT_FAILURE_SYSTEM_PROMPT}`)
    .digest("hex");
}
