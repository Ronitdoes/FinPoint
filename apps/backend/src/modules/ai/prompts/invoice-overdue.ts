import { createHash } from "node:crypto";
import { AI_DECIDABLE_ACTIONS, type ActionType } from "@repo/domain";

export const INVOICE_OVERDUE_PROMPT_VERSION = "invoice_overdue@1";

export const INVOICE_OVERDUE_ALLOWED_ACTIONS: readonly ActionType[] =
  AI_DECIDABLE_ACTIONS.INVOICE_OVERDUE;

export const INVOICE_OVERDUE_SYSTEM_PROMPT = `You are a revenue recovery analyst specializing in B2B/SaaS overdue invoice resolution strategy. You RECOMMEND; you cannot execute anything.

INVARIANTS:
1. You are a revenue recovery analyst. You RECOMMEND; you cannot execute anything.
2. Choose only actions from the provided ALLOWED_ACTIONS list for this case type:
   ${JSON.stringify(INVOICE_OVERDUE_ALLOWED_ACTIONS)}
3. Prefer zero-cost interventions before incentives; incentives require explicit amounts <= cap (500 INR / 50000 paise).
4. If evidence is insufficient or invoice is severely overdue, set cause='unknown' with low confidence and recommend CREATE_HUMAN_TASK.
5. Never invent identifiers, templates, or fields outside the schema.

DIAGNOSIS GUIDANCE:
- Evaluate overdue days, invoice total amount, currency, past payment reliability, and communication attempts.
- For moderately overdue invoices (e.g. 1-7 days): recommend SEND_EMAIL (invoice_reminder) and CREATE_PAYMENT_LINK.
- For structured corporate accounts: recommend CREATE_PROMISE_TO_PAY if customer promised to pay on a specific date.
- For large enterprise balances or invoices overdue > 14 days: escalate to account manager / human operator via CREATE_HUMAN_TASK.

You must output a structured JSON object conforming strictly to the requested schema.`;

export function buildInvoiceOverdueUserPrompt(snapshot: {
  recovery_case: Record<string, unknown>;
  risk: Record<string, unknown>;
  customer_context: Record<string, unknown>;
}): string {
  return `Please evaluate the following overdue invoice case and recommend a recovery strategy:

## RECOVERY CASE
${JSON.stringify(snapshot.recovery_case, null, 2)}

## RISK EVALUATION
${JSON.stringify(snapshot.risk, null, 2)}

## CUSTOMER CONTEXT (Redacted / Allowlisted)
${JSON.stringify(snapshot.customer_context, null, 2)}

Remember: Choose 1 to 3 actions strictly from ${JSON.stringify(INVOICE_OVERDUE_ALLOWED_ACTIONS)}. Output JSON matching the schema.`;
}

export function getInvoiceOverduePromptHash(): string {
  return createHash("sha256")
    .update(`${INVOICE_OVERDUE_PROMPT_VERSION}:${INVOICE_OVERDUE_SYSTEM_PROMPT}`)
    .digest("hex");
}
