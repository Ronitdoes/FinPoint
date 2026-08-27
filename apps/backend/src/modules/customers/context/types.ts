import { z } from "zod";
import { CUSTOMER_STATUSES } from "@repo/domain";

/**
 * Zod Schemas and Runtime Contracts for Customer Context (Spec 01 §9, s-13).
 * Every sub-object is strictly validated with .strict() to reject unknown injected keys.
 */

export const CustomerProfileContextSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    status: z.enum(CUSTOMER_STATUSES),
    lifetime_value_minor: z.number().int(),
    tenure_days: z.number().int().nonnegative(),
    opted_out: z.boolean(),
    email_masked: z.string().nullable().optional(),
    phone_masked: z.string().nullable().optional(),
  })
  .strict();

export const PaymentSummaryContextSchema = z
  .object({
    succeeded_count_180d: z.number().int().nonnegative(),
    failed_count_180d: z.number().int().nonnegative(),
    last_success_at: z.string().nullable(),
    last_failure_at: z.string().nullable(),
    last_failure_code: z.string().nullable(),
    avg_amount_minor: z.number().int().nonnegative(),
    total_paid_minor: z.number().int().nonnegative(),
  })
  .strict();

export const SubscriptionSummaryContextSchema = z
  .object({
    status: z.string().nullable(),
    plan_name: z.string().nullable(),
    amount_minor: z.number().int().nonnegative(),
    renewals_count: z.number().int().nonnegative(),
    past_due_events: z.number().int().nonnegative(),
  })
  .strict();

export const InvoiceSummaryContextSchema = z
  .object({
    open_count: z.number().int().nonnegative(),
    overdue_count: z.number().int().nonnegative(),
    worst_days_overdue: z.number().int().nonnegative(),
    total_overdue_minor: z.number().int().nonnegative(),
  })
  .strict();

export const CheckoutSummaryContextSchema = z
  .object({
    active_carts: z.number().int().nonnegative(),
    abandoned_count_90d: z.number().int().nonnegative(),
    last_cart_value_minor: z.number().int().nonnegative(),
  })
  .strict();

export const RecoveryOutcomeSummarySchema = z
  .object({
    case_id: z.string().uuid(),
    amount_recovered_minor: z.number().int().nonnegative(),
    at: z.string(),
  })
  .strict();

export const RecoveryHistoryContextSchema = z
  .object({
    prior_cases: z.number().int().nonnegative(),
    recovered_cases: z.number().int().nonnegative(),
    stopped_cases: z.number().int().nonnegative(),
    escalated_cases: z.number().int().nonnegative(),
    last_outcome: RecoveryOutcomeSummarySchema.nullable(),
    retry_success_rate: z.number().min(0).max(1),
  })
  .strict();

export const CommunicationHistoryContextSchema = z
  .object({
    whatsapp_last_7d: z.number().int().nonnegative(),
    email_last_14d: z.number().int().nonnegative(),
    sms_last_7d: z.number().int().nonnegative(),
    last_contacted_at: z.string().nullable(),
    reply_rate: z.number().min(0).max(1),
    opt_out_at: z.string().nullable(),
  })
  .strict();

export const PreferencesContextSchema = z
  .object({
    preferred_channel: z.string().nullable(),
    language: z.string().nullable(),
  })
  .strict();

export const CustomerContextSchema = z
  .object({
    built_at: z.string(),
    customer: CustomerProfileContextSchema,
    payment_summary: PaymentSummaryContextSchema,
    subscription_summary: SubscriptionSummaryContextSchema,
    invoice_summary: InvoiceSummaryContextSchema,
    checkout_summary: CheckoutSummaryContextSchema,
    recovery_history: RecoveryHistoryContextSchema,
    communication_history: CommunicationHistoryContextSchema,
    preferences: PreferencesContextSchema,
  })
  .strict();

export const ContextPurposeSchema = z.enum(["api_read", "ai_decision"]);

export type CustomerProfileContext = z.infer<typeof CustomerProfileContextSchema>;
export type PaymentSummaryContext = z.infer<typeof PaymentSummaryContextSchema>;
export type SubscriptionSummaryContext = z.infer<typeof SubscriptionSummaryContextSchema>;
export type InvoiceSummaryContext = z.infer<typeof InvoiceSummaryContextSchema>;
export type CheckoutSummaryContext = z.infer<typeof CheckoutSummaryContextSchema>;
export type RecoveryOutcomeSummary = z.infer<typeof RecoveryOutcomeSummarySchema>;
export type RecoveryHistoryContext = z.infer<typeof RecoveryHistoryContextSchema>;
export type CommunicationHistoryContext = z.infer<typeof CommunicationHistoryContextSchema>;
export type PreferencesContext = z.infer<typeof PreferencesContextSchema>;
export type CustomerContext = z.infer<typeof CustomerContextSchema>;
export type ContextPurpose = z.infer<typeof ContextPurposeSchema>;

export interface BuildCustomerContextInput {
  tenantId: string;
  customerId: string;
  purpose?: ContextPurpose;
  forceFresh?: boolean;
  now?: Date;
}
