import {
  findCheckoutById,
  updateCheckoutStatus,
  recordCaseEvent,
} from "@repo/db";
import { resolvePaymentProvider, type PaymentProvider } from "@repo/integrations";
import { workerConfig } from "@repo/config";
import {
  type ActivityContext,
  withActivityContext,
  withActivityDb,
} from "../framework";

export interface CreatePaymentLinkInput extends ActivityContext {
  customerId: string;
  amountMinor: string | bigint;
  currency: string;
  checkoutId?: string;
  invoiceId?: string;
  customerEmail?: string;
  description?: string;
  expiresInMinutes?: number;
  provider?: string;
}

export interface CreatePaymentLinkResult {
  paymentLinkId: string;
  url: string;
  expiresAt?: string;
}

/**
 * Activity: createPaymentLinkAndStore
 * Generates a hosted payment / recovery link through the payment provider and records it.
 */
export async function createPaymentLinkAndStore(
  input: CreatePaymentLinkInput,
): Promise<CreatePaymentLinkResult> {
  return await withActivityContext("createPaymentLinkAndStore", input, async () => {
    const config = workerConfig();
    const providerName = (input.provider ?? "mock").toLowerCase();
    const adapter: PaymentProvider = resolvePaymentProvider({
      provider: providerName,
      paymentsConfig: config.payments,
      demoConfig: config.demo,
    });

    const idempotencyKey = `${input.tenantId}:${input.caseId}:PAYMENT_LINK`;
    const amount = BigInt(input.amountMinor);
    const result = await adapter.createPaymentLink({
      tenantId: input.tenantId,
      caseId: input.caseId,
      customerId: input.customerId,
      amount,
      currency: input.currency,
      idempotencyKey,
      customerEmail: input.customerEmail,
      description: input.description ?? `Recovery Payment Link for Case ${input.caseId}`,
      expiresInMinutes: input.expiresInMinutes ?? 1440, // 24 hours default
      metadata: {
        caseId: input.caseId,
        checkoutId: input.checkoutId,
        invoiceId: input.invoiceId,
      },
    });

    await withActivityDb(input, async (db, tx) => {
      // If checkoutId provided, link it
      if (input.checkoutId) {
        const checkout = await findCheckoutById(
          { db, tx },
          { tenantId: input.tenantId, checkoutId: input.checkoutId },
        );
        if (checkout) {
          await updateCheckoutStatus(
            { db, tx },
            {
              tenantId: input.tenantId,
              checkoutId: input.checkoutId,
              status: "ABANDONED",
            },
          );
        }
      }

      // Record timeline event
      await recordCaseEvent(
        { db, tx },
        {
          tenantId: input.tenantId,
          caseId: input.caseId,
          eventType: "PAYMENT_LINK_CREATED",
          actorType: "SYSTEM",
          description: "Payment recovery link generated",
          payload: {
            url: result.url,
            paymentLinkId: result.paymentLinkId,
            expiresAt: result.expiresAt?.toISOString(),
          },
        },
      );
    });

    return {
      paymentLinkId: result.paymentLinkId,
      url: result.url,
      expiresAt: result.expiresAt?.toISOString(),
    };
  });
}
