import {
  findCustomerById,
  findMessageByIdempotencyKey,
  countCustomerMessagesByChannelSince,
  insertMessage,
  updateMessageStatus,
  recordDeliveryEvent,
  completeAction,
  failAction,
  recordCaseEvent,
  DuplicateMessageError,
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
      // 2. Fast-path idempotency lookup (backend order §4): return existing
      // ledger record without re-dispatching when this key already sent.
      const fastPathExisting = await findMessageByIdempotencyKey(
        { db, tx },
        { tenantId: input.tenantId, idempotencyKey },
      );
      if (fastPathExisting) {
        return {
          messageId: fastPathExisting.id,
          externalMessageId: fastPathExisting.providerMessageId ?? undefined,
          status: fastPathExisting.status,
        };
      }

      // 3. Customer opt-out check
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

      // 4. Defense-in-depth contact-cap recheck (mirrors
      // apps/backend send.service.ts §7: WA 7d>=2 block, Email 14d>=3 block).
      const now = new Date();
      if (input.channel === "WHATSAPP") {
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const sentCount7d = await countCustomerMessagesByChannelSince(
          { db, tx },
          {
            tenantId: input.tenantId,
            customerId: input.customerId,
            channel: "WHATSAPP",
            since: sevenDaysAgo,
          },
        );
        if (sentCount7d >= 2) {
          throw createNonRetryableFailure(
            `Contact cap exceeded for channel 'WHATSAPP': maximum 2 message(s) per 7 day(s)`,
            "POLICY_REJECTED",
          );
        }
      } else if (input.channel === "EMAIL") {
        const fourteenDaysAgo = new Date(
          now.getTime() - 14 * 24 * 60 * 60 * 1000,
        );
        const sentCount14d = await countCustomerMessagesByChannelSince(
          { db, tx },
          {
            tenantId: input.tenantId,
            customerId: input.customerId,
            channel: "EMAIL",
            since: fourteenDaysAgo,
          },
        );
        if (sentCount14d >= 3) {
          throw createNonRetryableFailure(
            `Contact cap exceeded for channel 'EMAIL': maximum 3 message(s) per 14 day(s)`,
            "POLICY_REJECTED",
          );
        }
      }

      // 5. QUEUED anchor pre-dispatch (backend order §8): concurrent racers
      // converge on the unique idempotency key; losers return the winner.
      const providerEnum =
        input.channel === "WHATSAPP"
          ? "WHATSAPP_CLOUD"
          : input.channel === "EMAIL"
            ? "SMTP_EMAIL"
            : "MOCK";
      let messageRecord;
      try {
        messageRecord = await insertMessage(
          { db, tx },
          {
            tenantId: input.tenantId,
            caseId: input.caseId,
            customerId: input.customerId,
            channel: input.channel,
            provider: providerEnum,
            direction: "OUTBOUND",
            templateId: input.templateName,
            variables: input.templateVariables,
            toAddress,
            idempotencyKey,
            status: "QUEUED",
          },
        );
      } catch (error) {
        if (error instanceof DuplicateMessageError) {
          const existing = await findMessageByIdempotencyKey(
            { db, tx },
            { tenantId: input.tenantId, idempotencyKey },
          );
          if (existing) {
            return {
              messageId: existing.id,
              externalMessageId: existing.providerMessageId ?? undefined,
              status: existing.status,
            };
          }
        }
        throw error;
      }

      // 6. Dispatch via adapter (step 31: crash window hooks around the side effect)
      let sendResult: Awaited<ReturnType<typeof adapter.sendTemplate>>;
      try {
        await checkFaultPoint("sendTemplateMessage", "before_provider_call", {
          tenantId: input.tenantId,
          caseId: input.caseId,
          idempotencyKey,
        });
        sendResult = await adapter.sendTemplate({
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
      } catch (dispatchErr: unknown) {
        // Mirror backend §10: persist FAILED, append receipt, fail action, rethrow.
        const failedAt = new Date();
        await updateMessageStatus(
          { db, tx },
          {
            tenantId: input.tenantId,
            messageId: messageRecord.id,
            status: "FAILED",
            finalStatusAt: failedAt,
          },
        );
        await recordDeliveryEvent(
          { db, tx },
          {
            messageId: messageRecord.id,
            status: "FAILED",
            payload: {
              error:
                dispatchErr instanceof Error
                  ? dispatchErr.message
                  : String(dispatchErr),
              code: (dispatchErr as { code?: unknown })?.code,
            },
            occurredAt: failedAt,
          },
        );
        if (input.actionId) {
          await failAction(
            { db, tx },
            {
              tenantId: input.tenantId,
              actionId: input.actionId,
              error: {
                messageId: messageRecord.id,
                status: "FAILED",
              },
            },
          );
        }
        throw dispatchErr;
      }

      // 7. Post-dispatch crash window, then SENT/FAILED guarded update.
      await checkFaultPoint("sendTemplateMessage", "after_provider_call", {
        tenantId: input.tenantId,
        caseId: input.caseId,
        idempotencyKey,
      });

      const isFailed = sendResult.status === "FAILED";
      const settledAt = sendResult.acceptedAt ?? new Date();
      await updateMessageStatus(
        { db, tx },
        {
          tenantId: input.tenantId,
          messageId: messageRecord.id,
          status: isFailed ? "FAILED" : "SENT",
          ...(isFailed
            ? { finalStatusAt: settledAt }
            : {
                providerMessageId: sendResult.providerMessageId,
                sentAt: settledAt,
              }),
        },
      );

      await recordDeliveryEvent(
        { db, tx },
        {
          messageId: messageRecord.id,
          status: isFailed ? "FAILED" : "SENT",
          payload: sendResult.rawResponse as Record<string, unknown>,
          occurredAt: settledAt,
        },
      );

      // If actionId was provided, update action status
      if (input.actionId) {
        if (isFailed) {
          await failAction(
            { db, tx },
            {
              tenantId: input.tenantId,
              actionId: input.actionId,
              error: {
                messageId: messageRecord.id,
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
                messageId: messageRecord.id,
                status: sendResult.status,
              },
            },
          );
        }
      }

      // 8. Append timeline event
      await recordCaseEvent(
        { db, tx },
        {
          tenantId: input.tenantId,
          caseId: input.caseId,
          eventType: "MESSAGE_SENT",
          actorType: "SYSTEM",
          description: `Sent ${input.channel} template '${input.templateName}'`,
          payload: {
            messageId: messageRecord.id,
            channel: input.channel,
            templateName: input.templateName,
            status: sendResult.status,
          },
        },
      );

      return {
        messageId: messageRecord.id,
        externalMessageId: sendResult.providerMessageId,
        status: sendResult.status,
      };
    });
  });
}
