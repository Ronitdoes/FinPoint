import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import type { MessageStatus, DomainEvent } from "@repo/domain";
import { NotAcceptableError } from "../../../lib/errors";
import { checkIpBlock } from "../../security/ip-block.service";
import { recordWebhookAuthFailure } from "../../security/webhook-abuse";

export interface EmailWebhookOptions {
  webhookSecret?: string | null;
}

/**
 * Email Status & Inbound Webhook Handlers.
 * Spec 01 §14, Spec 19 §Requirements 5.
 */
export const emailWebhookRoutes: FastifyPluginAsync<EmailWebhookOptions> = async (
  fastify,
  opts,
) => {
  const validateContentType = async (request: FastifyRequest, _reply: FastifyReply) => {
    const contentType = request.headers["content-type"];
    if (!contentType || !contentType.toLowerCase().includes("application/json")) {
      throw new NotAcceptableError("Content-Type must be application/json");
    }
  };

  const getSecret = (): string => {
    return (
      opts.webhookSecret ||
      (fastify as any).config?.messaging?.emailWebhookSecret ||
      process.env.EMAIL_WEBHOOK_SECRET ||
      "email_webhook_secret"
    );
  };

  // Handler implementation for email status callbacks
  const handleEmailWebhook = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as Record<string, string | undefined>;
    const tokenInPath = params?.token;
    const headerToken =
      (request.headers["x-webhook-token"] as string | undefined) ||
      (request.headers["authorization"] as string | undefined)?.replace(/^Bearer\s+/i, "");

    const expectedSecret = getSecret();
    const providedToken = tokenInPath || headerToken;

    // Verify token / secret
    if (providedToken && providedToken !== expectedSecret) {
      await recordWebhookAuthFailure(fastify, request, "EMAIL");
      return reply.status(401).send({
        error: {
          code: "UNAUTHORIZED",
          message: "Invalid email webhook authentication token",
        },
      });
    }

    const body = request.body as any;
    const events = Array.isArray(body) ? body : [body];

    for (const evt of events) {
      const providerMessageId =
        evt.email_id || evt.id || evt.provider_message_id || evt.data?.email_id || evt.data?.id;
      const rawEvent = (evt.type || evt.event || evt.status || "").toLowerCase();
      const timestamp = evt.created_at ? new Date(evt.created_at) : new Date();

      let targetStatus: MessageStatus | null = null;
      if (rawEvent.includes("delivered")) targetStatus = "DELIVERED";
      else if (rawEvent.includes("opened") || rawEvent.includes("read") || rawEvent.includes("click")) targetStatus = "READ";
      else if (rawEvent.includes("bounce")) targetStatus = "BOUNCED";
      else if (rawEvent.includes("dropped") || rawEvent.includes("reject")) targetStatus = "REJECTED";
      else if (rawEvent.includes("fail")) targetStatus = "FAILED";

      if (providerMessageId) {
        const existingMsg = await fastify.repos.findMessageByProviderMessageId({ db: fastify.db }, {
          providerMessageId,
        });

        if (existingMsg) {
          const currentStatus = existingMsg.status;
          const isTerminal =
            currentStatus === "FAILED" ||
            currentStatus === "BOUNCED" ||
            currentStatus === "REJECTED";

          if (targetStatus) {
            await fastify.repos.recordDeliveryEvent({ db: fastify.db }, {
              messageId: existingMsg.id,
              status: targetStatus,
              occurredAt: timestamp,
              payload: {
                provider: "SMTP_EMAIL",
                raw_event: rawEvent,
                data: evt,
              },
            });

            if (!isTerminal && currentStatus !== targetStatus) {
              await fastify.repos.updateMessageStatus({ db: fastify.db }, {
                tenantId: existingMsg.tenantId,
                messageId: existingMsg.id,
                status: targetStatus,
                finalStatusAt: targetStatus === "FAILED" || targetStatus === "BOUNCED" ? timestamp : undefined,
              });
            }
          }

          // Unsubscribe / Spam complaint handling
          if (rawEvent.includes("unsubscribe") || rawEvent.includes("spam")) {
            await fastify.repos.setCustomerOptOut({ db: fastify.db }, {
              tenantId: existingMsg.tenantId,
              customerId: existingMsg.customerId,
              optedOut: true,
            });

            await fastify.repos.createCustomerResponse({ db: fastify.db }, {
              tenantId: existingMsg.tenantId,
              customerId: existingMsg.customerId,
              channel: "EMAIL",
              type: "OPT_OUT",
              contentRedacted: "UNSUBSCRIBE_EMAIL_WEBHOOK",
              rawRef: providerMessageId,
            });

            const domainEvent: DomainEvent = {
              id: randomUUID(),
              type: "customer.opted_out",
              occurred_at: new Date().toISOString(),
              source: "email",
              tenant_id: existingMsg.tenantId,
              customer_id: existingMsg.customerId,
              entity_id: existingMsg.customerId,
              entity_type: "CUSTOMER",
              payload: {
                customer_id: existingMsg.customerId,
                channel: "EMAIL",
                reason: rawEvent,
                message_ref: providerMessageId,
              },
              correlation_id: request.correlationId || randomUUID(),
            };

            if (fastify.eventBus) {
              await fastify.eventBus.publish(domainEvent);
            }
          }
        }
      }
    }

    return reply.status(200).send({ accepted: true });
  };

  // POST /webhooks/email
  fastify.post(
    "/",
    {
      config: {
        rateLimit: {
          max: 600,
          timeWindow: "1 minute",
        },
      },
      preHandler: [checkIpBlock, validateContentType],
    },
    handleEmailWebhook,
  );

  // POST /webhooks/email/:token
  fastify.post(
    "/:token",
    {
      config: {
        rateLimit: {
          max: 600,
          timeWindow: "1 minute",
        },
      },
      preHandler: [checkIpBlock, validateContentType],
    },
    handleEmailWebhook,
  );
};
