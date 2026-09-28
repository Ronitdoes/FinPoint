import type { FastifyBaseLogger } from "fastify";
import type { Database, Tx } from "@repo/db";
import type Redis from "ioredis";
import type { Repositories } from "../../plugins/db";
import type { MessagingConfig, DemoConfig } from "@repo/config";
import type { SendCaseMessageInput, SendCaseMessageResult } from "./types";
import {
  assertValidTemplateVariables,
  messagingProviderFor,
  type MessagingProvider,
} from "@repo/integrations";
import { DuplicateMessageError } from "@repo/db";
import { maskEmail, maskPhone } from "../customers/context/allowlist";
import { CustomerContextService } from "../customers/customer-context.service";

export interface SendMessageServiceDeps {
  db: Database;
  repos: Repositories;
  logger?: FastifyBaseLogger;
  messagingConfig?: MessagingConfig | null;
  demoConfig?: DemoConfig | null;
  customAdapter?: MessagingProvider;
  redis?: Redis | null;
}

export class CustomerOptedOutError extends Error {
  readonly code = "CUSTOMER_OPTED_OUT";
  constructor(customerId: string) {
    super(`Customer '${customerId}' has opted out of communications`);
    this.name = "CustomerOptedOutError";
  }
}

export class CustomerContactMissingError extends Error {
  readonly code = "CUSTOMER_CONTACT_MISSING";
  constructor(customerId: string, channel: string) {
    super(`Customer '${customerId}' is missing required contact address for channel '${channel}'`);
    this.name = "CustomerContactMissingError";
  }
}

export class ContactCapExceededError extends Error {
  readonly code = "CONTACT_CAP_EXCEEDED";
  readonly channel: string;
  readonly limit: number;
  readonly periodDays: number;

  constructor(channel: string, limit: number, periodDays: number) {
    super(
      `Contact cap exceeded for channel '${channel}': maximum ${limit} message(s) per ${periodDays} day(s)`,
    );
    this.name = "ContactCapExceededError";
    this.channel = channel;
    this.limit = limit;
    this.periodDays = periodDays;
  }
}

/**
 * Derives the standard idempotency key for customer contact messages:
 * `{tenant}:{case}:{channel}:{template}:{step}` (Spec 01 §21, Spec 19 §4).
 */
export function deriveMessageIdempotencyKey(input: {
  tenantId: string;
  caseId?: string;
  channel: string;
  templateId: string;
  step?: number;
}): string {
  const casePart = input.caseId || "direct";
  const stepPart = input.step ?? 1;
  return `${input.tenantId}:${casePart}:${input.channel}:${input.templateId}:${stepPart}`;
}

/**
 * Messaging send pipeline: customer resolution, cap recheck, idempotent persistence,
 * adapter dispatch, and delivery ledger recording (Spec 01 §14, Spec 02 §7, s-19).
 */
export async function sendCaseMessage(
  deps: SendMessageServiceDeps,
  input: SendCaseMessageInput,
): Promise<SendCaseMessageResult> {
  const { db, repos, logger, messagingConfig, demoConfig, customAdapter, redis } = deps;
  const tenantId = input.tenantId;

  // 1. Resolve Customer & Case
  let customerId = input.customerId;
  if (!customerId && input.caseId) {
    const recoveryCase = await repos.findCaseById({ db }, { tenantId, caseId: input.caseId });
    if (recoveryCase) {
      customerId = recoveryCase.customerId;
    }
  }

  if (!customerId) {
    throw new Error("Cannot send message: customerId could not be resolved");
  }

  const customer = await repos.findCustomerById({ db }, { tenantId, customerId });
  if (!customer) {
    throw new Error(`Customer '${customerId}' not found`);
  }

  // 2. Validate Template & Variables Allowlist
  assertValidTemplateVariables(input.templateId, input.variables);

  // 3. Derive Idempotency Key (Spec 01 §21, Spec 19 §4)
  const idempotencyKey =
    input.overrideIdempotencyKey ||
    deriveMessageIdempotencyKey({
      tenantId,
      caseId: input.caseId,
      channel: input.channel,
      templateId: input.templateId,
      step: input.step,
    });

  // 4. Fast-path Idempotency Check — Return existing record if already dispatched
  const existingMessage = await repos.findMessageByIdempotencyKey({ db }, { tenantId, idempotencyKey });
  if (existingMessage) {
    logger?.info(
      { tenantId, messageId: existingMessage.id, idempotencyKey },
      "Existing message found for idempotency key; returning existing ledger record",
    );
    return {
      messageId: existingMessage.id,
      status: existingMessage.status,
      idempotencyKey: existingMessage.idempotencyKey,
      channel: existingMessage.channel,
      templateId: existingMessage.templateId,
      toAddress: existingMessage.toAddress,
      providerMessageId: existingMessage.providerMessageId ?? undefined,
      isDuplicate: true,
      sentAt: existingMessage.sentAt ?? undefined,
    };
  }

  // 5. Customer Opt-Out Check (Spec 19 §Opt-out handling)
  if (customer.optedOut) {
    logger?.warn({ tenantId, customerId, channel: input.channel }, "Blocked send: customer has opted out");
    throw new CustomerOptedOutError(customerId);
  }

  // 6. Resolve Destination Address from DB strictly (Spec 19 §Variable allowlist enforcement)
  let toAddress = "";
  if (input.channel === "WHATSAPP" || input.channel === "SMS") {
    if (!customer.phone || customer.phone.trim() === "") {
      throw new CustomerContactMissingError(customerId, input.channel);
    }
    toAddress = customer.phone.trim();
  } else if (input.channel === "EMAIL") {
    if (!customer.email || customer.email.trim() === "") {
      throw new CustomerContactMissingError(customerId, input.channel);
    }
    toAddress = customer.email.trim();
  }

  // 7. Policy Counters Defense-in-Depth Recheck (Spec 19 §4, Spec 16)
  const now = new Date();
  if (input.channel === "WHATSAPP") {
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const sentCount7d = await repos.countCustomerMessagesByChannelSince({ db }, {
      tenantId,
      customerId,
      channel: "WHATSAPP",
      since: sevenDaysAgo,
    });
    if (sentCount7d >= 2) {
      logger?.warn({ tenantId, customerId, sentCount7d }, "Defense-in-depth cap recheck failed: WhatsApp 7d cap >= 2");
      throw new ContactCapExceededError("WHATSAPP", 2, 7);
    }
  } else if (input.channel === "EMAIL") {
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const sentCount14d = await repos.countCustomerMessagesByChannelSince({ db }, {
      tenantId,
      customerId,
      channel: "EMAIL",
      since: fourteenDaysAgo,
    });
    if (sentCount14d >= 3) {
      logger?.warn({ tenantId, customerId, sentCount14d }, "Defense-in-depth cap recheck failed: Email 14d cap >= 3");
      throw new ContactCapExceededError("EMAIL", 3, 14);
    }
  }

  // 8. Atomic Insert (QUEUED status) — Anti-duplication anchor #4
  let messageRecord: any;
  try {
    const providerEnum =
      input.channel === "WHATSAPP"
        ? "WHATSAPP_CLOUD"
        : input.channel === "EMAIL"
          ? "SMTP_EMAIL"
          : "MOCK";

    messageRecord = await repos.insertMessage({ db }, {
      tenantId,
      caseId: input.caseId,
      customerId,
      channel: input.channel,
      direction: "OUTBOUND",
      templateId: input.templateId,
      variables: input.variables,
      toAddress,
      provider: providerEnum,
      idempotencyKey,
      status: "QUEUED",
    });
  } catch (error) {
    if (error instanceof DuplicateMessageError) {
      // Existing message found: return existing without dispatching
      const existing = await repos.findMessageByIdempotencyKey({ db }, { tenantId, idempotencyKey });
      if (existing) {
        logger?.info(
          { tenantId, messageId: existing.id, idempotencyKey },
          "Duplicate message send skipped; returning existing ledger record",
        );
        return {
          messageId: existing.id,
          status: existing.status,
          idempotencyKey: existing.idempotencyKey,
          channel: existing.channel,
          templateId: existing.templateId,
          toAddress: existing.toAddress,
          providerMessageId: existing.providerMessageId ?? undefined,
          isDuplicate: true,
          sentAt: existing.sentAt ?? undefined,
        };
      }
    }
    throw error;
  }

  // 8. Dispatch via Adapter
  const adapter =
    customAdapter ||
    messagingProviderFor(
      {
        messaging: messagingConfig ?? undefined,
        demo: demoConfig ?? undefined,
      },
      input.channel,
    );

  const maskedAddress =
    input.channel === "EMAIL" ? maskEmail(toAddress) : maskPhone(toAddress);

  logger?.info(
    {
      tenantId,
      messageId: messageRecord.id,
      channel: input.channel,
      templateId: input.templateId,
      to: maskedAddress,
    },
    "Dispatching templated message to provider",
  );

  try {
    const sendResult = await adapter.sendTemplate({
      tenantId,
      caseId: input.caseId,
      customerId,
      channel: input.channel,
      templateId: input.templateId,
      variables: input.variables,
      toAddress,
      idempotencyKey,
      language: input.language,
    });

    // 9. Update SENT status and record delivery receipt
    const sentAt = sendResult.acceptedAt || new Date();
    await repos.updateMessageStatus({ db }, {
      tenantId,
      messageId: messageRecord.id,
      status: "SENT",
      providerMessageId: sendResult.providerMessageId,
      sentAt,
    });

    await repos.recordDeliveryEvent({ db }, {
      messageId: messageRecord.id,
      status: "SENT",
      occurredAt: sentAt,
      payload: {
        provider_message_id: sendResult.providerMessageId,
        raw: sendResult.rawResponse,
      },
    });

    // s-13 freshness: bust cached customer context (communication counters changed).
    // Best-effort — cache failure must never fail the send path.
    try {
      await CustomerContextService.invalidateCache(redis, tenantId, customerId);
    } catch (err: any) {
      logger?.warn(
        { err: err?.message, tenantId, customerId },
        "Customer context cache bust failed after message SENT (best-effort)",
      );
    }

    return {
      messageId: messageRecord.id,
      status: "SENT",
      idempotencyKey,
      channel: input.channel,
      templateId: input.templateId,
      toAddress,
      providerMessageId: sendResult.providerMessageId,
      sentAt,
    };
  } catch (dispatchErr: any) {
    // 10. Update FAILED status and record failure receipt
    const failedAt = new Date();
    await repos.updateMessageStatus({ db }, {
      tenantId,
      messageId: messageRecord.id,
      status: "FAILED",
      finalStatusAt: failedAt,
    });

    await repos.recordDeliveryEvent({ db }, {
      messageId: messageRecord.id,
      status: "FAILED",
      occurredAt: failedAt,
      payload: {
        error: dispatchErr.message,
        code: dispatchErr.code,
      },
    });

    logger?.error(
      {
        tenantId,
        messageId: messageRecord.id,
        err: dispatchErr.message,
      },
      "Message dispatch failed",
    );

    throw dispatchErr;
  }
}
