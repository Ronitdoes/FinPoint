import {
  findCustomerById,
  insertMessage,
  recordDeliveryEvent,
  completeAction,
  failAction,
  recordCaseEvent,
} from "@repo/db";
import {
  resolveMessagingProvider,
  assertValidTemplateVariables,
  type MessagingProvider,
} from "@repo/integrations";
import { workerConfig } from "@repo/config";
import {
  type ActivityContext,
  withActivityContext,
  withActivityDb,
  createNonRetryableFailure,
  checkFaultPoint,
} from "../framework";

export interface SendTemplateMessageInput extends ActivityContext {
  customerId: string;
  channel: "WHATSAPP" | "EMAIL" | "SMS";
  templateName: string;
  templateLang?: string;
  templateVariables: Record<string, string>;
  stepKey: string;
  actionId?: string;
}

export interface SendTemplateMessageResult {
  messageId: string;
  externalMessageId?: string;
  status: string;
}

/**
 * Activity: sendTemplateMessage
 * Dispatches an allowlisted template message through the messaging adapter with
 * idempotency checks and customer opt-out verification.
 */
export async function sendTemplateMessage(
  input: SendTemplateMessageInput,
): Promise<SendTemplateMessageResult> {
  return await withActivityContext("sendTemplateMessage", input, async () => {
    // 1. Validate template variables against allowlist
    try {
      assertValidTemplateVariables(input.templateName, input.templateVariables);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw createNonRetryableFailure(
        `Template validation failed: ${message}`,
        "VALIDATION_FAILED",
      );
    }

    const config = workerConfig();
    const adapter: MessagingProvider = resolveMessagingProvider({
      channel: input.channel,
      messagingConfig: config.messaging,
      demoConfig: config.demo,
    });

    const idempotencyKey = `${input.tenantId}:${input.caseId}:${input.channel}:${input.templateName}:${input.stepKey}`;

    return await withActivityDb(input, async (db, tx) => {
      // 2. Customer opt-out check
      const customer = await findCustomerById(
        { db, tx },
        { tenantId: input.tenantId, customerId: input.customerId },
      );

      if (!customer) {
        throw createNonRetryableFailure(
          `Customer '${input.customerId}' not found`,
          "ENTITY_NOT_FOUND",
        );
      }

      if (customer.optedOut) {
        throw createNonRetryableFailure(
          `Customer '${input.customerId}' has opted out of communications`,
          "CUSTOMER_OPTED_OUT",
        );
      }

      const toAddress =
        input.channel === "WHATSAPP" || input.channel === "SMS"
          ? customer.phone
          : customer.email;

      if (!toAddress) {
        throw createNonRetryableFailure(
          `Customer '${input.customerId}' missing contact address for channel '${input.channel}'`,
          "VALIDATION_FAILED",
        );
      }

      // 3. Dispatch via adapter (step 31: crash window hooks around the side effect)
      await checkFaultPoint("sendTemplateMessage", "before_provider_call", {
        tenantId: input.tenantId,
        caseId: input.caseId,
        idempotencyKey,
      });
      const sendResult = await adapter.sendTemplate({
        tenantId: input.tenantId,
        caseId: input.caseId,
        customerId: input.customerId,
        channel: input.channel,
        templateId: input.templateName,
        variables: input.templateVariables,
        toAddress,
        idempotencyKey,
        language: input.templateLang ?? "en",
        metadata: {
          caseId: input.caseId,
          customerId: input.customerId,
          stepKey: input.stepKey,
        },
      });

      // 4. Record message and delivery event (step 31: post-dispatch crash window)
      await checkFaultPoint("sendTemplateMessage", "after_provider_call", {
        tenantId: input.tenantId,
        caseId: input.caseId,
        idempotencyKey,
      });
      const createdMessage = await insertMessage(
        { db, tx },
        {
          tenantId: input.tenantId,
          caseId: input.caseId,
          customerId: input.customerId,
          channel: input.channel,
          provider: "MOCK",
          direction: "OUTBOUND",
          templateId: input.templateName,
          variables: input.templateVariables,
          toAddress,
          idempotencyKey,
          status: sendResult.status === "FAILED" ? "FAILED" : "SENT",
          providerMessageId: sendResult.providerMessageId,
          sentAt: new Date(),
        },
      );

      await recordDeliveryEvent(
        { db, tx },
        {
          messageId: createdMessage.id,
          status: sendResult.status === "FAILED" ? "FAILED" : "SENT",
          payload: sendResult.rawResponse as Record<string, unknown>,
          occurredAt: new Date(),
        },
      );

      // If actionId was provided, update action status
      if (input.actionId) {
        if (sendResult.status === "FAILED") {
          await failAction(
            { db, tx },
            {
              tenantId: input.tenantId,
              actionId: input.actionId,
              error: {
                messageId: createdMessage.id,
                status: sendResult.status,
              },
            },
          );
        } else {
          await completeAction(
            { db, tx },
            {
              tenantId: input.tenantId,
              actionId: input.actionId,
              result: {
                messageId: createdMessage.id,
                status: sendResult.status,
              },
            },
          );
        }
      }

      // 5. Append timeline event
      await recordCaseEvent(
        { db, tx },
        {
          tenantId: input.tenantId,
          caseId: input.caseId,
          eventType: "MESSAGE_SENT",
          actorType: "SYSTEM",
          description: `Sent ${input.channel} template '${input.templateName}'`,
          payload: {
            messageId: createdMessage.id,
            channel: input.channel,
            templateName: input.templateName,
            status: sendResult.status,
          },
        },
      );

      return {
        messageId: createdMessage.id,
        externalMessageId: sendResult.providerMessageId,
        status: sendResult.status,
      };
    });
  });
}
