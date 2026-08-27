import type { RiskType, ActionType } from "@repo/domain";
import {
  PAYMENT_FAILURE_PROMPT_VERSION,
  PAYMENT_FAILURE_SYSTEM_PROMPT,
  PAYMENT_FAILURE_ALLOWED_ACTIONS,
  buildPaymentFailureUserPrompt,
  getPaymentFailurePromptHash,
} from "./payment-failure";
import {
  CHECKOUT_ABANDONMENT_PROMPT_VERSION,
  CHECKOUT_ABANDONMENT_SYSTEM_PROMPT,
  CHECKOUT_ABANDONMENT_ALLOWED_ACTIONS,
  buildCheckoutAbandonmentUserPrompt,
  getCheckoutAbandonmentPromptHash,
} from "./checkout-abandonment";
import {
  INVOICE_OVERDUE_PROMPT_VERSION,
  INVOICE_OVERDUE_SYSTEM_PROMPT,
  INVOICE_OVERDUE_ALLOWED_ACTIONS,
  buildInvoiceOverdueUserPrompt,
  getInvoiceOverduePromptHash,
} from "./invoice-overdue";

export interface DecisionPromptSnapshot {
  recovery_case: Record<string, unknown>;
  risk: Record<string, unknown>;
  customer_context: Record<string, unknown>;
}

export interface PromptDefinition {
  readonly id: string;
  readonly version: string;
  readonly hash: string;
  readonly systemPrompt: string;
  readonly allowedActions: readonly ActionType[];
  readonly buildUserPrompt: (snapshot: DecisionPromptSnapshot) => string;
}

const PROMPT_REGISTRY: Record<string, PromptDefinition> = {
  PAYMENT_FAILURE: Object.freeze({
    id: "payment_failure",
    version: PAYMENT_FAILURE_PROMPT_VERSION,
    hash: getPaymentFailurePromptHash(),
    systemPrompt: PAYMENT_FAILURE_SYSTEM_PROMPT,
    allowedActions: PAYMENT_FAILURE_ALLOWED_ACTIONS,
    buildUserPrompt: buildPaymentFailureUserPrompt,
  }),
  CHECKOUT_ABANDONMENT: Object.freeze({
    id: "checkout_abandonment",
    version: CHECKOUT_ABANDONMENT_PROMPT_VERSION,
    hash: getCheckoutAbandonmentPromptHash(),
    systemPrompt: CHECKOUT_ABANDONMENT_SYSTEM_PROMPT,
    allowedActions: CHECKOUT_ABANDONMENT_ALLOWED_ACTIONS,
    buildUserPrompt: buildCheckoutAbandonmentUserPrompt,
  }),
  INVOICE_OVERDUE: Object.freeze({
    id: "invoice_overdue",
    version: INVOICE_OVERDUE_PROMPT_VERSION,
    hash: getInvoiceOverduePromptHash(),
    systemPrompt: INVOICE_OVERDUE_SYSTEM_PROMPT,
    allowedActions: INVOICE_OVERDUE_ALLOWED_ACTIONS,
    buildUserPrompt: buildInvoiceOverdueUserPrompt,
  }),
};

export class UnknownPromptSurfaceError extends Error {
  constructor(surface: string) {
    super(`No registered prompt definition for surface or risk type '${surface}'`);
    this.name = "UnknownPromptSurfaceError";
  }
}

/**
 * Resolves a prompt definition by risk type or surface name.
 */
export function getPrompt(surface: RiskType | string): PromptDefinition {
  const normalizedKey = surface.toUpperCase();
  const definition = PROMPT_REGISTRY[normalizedKey];
  if (!definition) {
    throw new UnknownPromptSurfaceError(surface);
  }
  return definition;
}

/**
 * Returns all registered prompt definitions (useful for prompt audit/governance).
 */
export function listPromptDefinitions(): PromptDefinition[] {
  return Object.values(PROMPT_REGISTRY);
}
