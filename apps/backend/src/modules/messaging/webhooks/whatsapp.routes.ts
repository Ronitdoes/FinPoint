import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import type { MessageStatus, CustomerResponseType, DomainEvent } from "@repo/domain";
import { NotAcceptableError } from "../../../lib/errors";
import { maskPhone } from "../../customers/context/allowlist";
import { checkIpBlock } from "../../security/ip-block.service";
import { recordWebhookAuthFailure } from "../../security/webhook-abuse";

export interface WhatsAppWebhookOptions {
  verifySecret?: string | null;
}

const OPT_OUT_REGEX = /^\s*(STOP|UNSUBSCRIBE|CANCEL|OPT\s*OUT|OPTOUT|QUIT|END)\b/i;
const PTP_REGEX = /\b(will pay|promise to pay|paying on|schedule payment|pay later|remit on)\b/i;
const COMPLAINT_REGEX = /\b(complaint|fraud|scam|dispute|lawyer|sue|harass|wrong person)\b/i;

/**
 * WhatsApp Cloud API Webhook Handlers: status callbacks & inbound customer replies.
 * Spec 01 §14, Spec 19 §Requirements 5 & 6.
 */
export const whatsappWebhookRoutes: FastifyPluginAsync<WhatsAppWebhookOptions> = async (
  fastify,
  opts,
) => {
  // Pre-handler hook to enforce application/json Content-Type for POST
  const validateContentType = async (request: FastifyRequest, _reply: FastifyReply) => {
    const contentType = request.headers["content-type"];
    if (!contentType || !contentType.toLowerCase().includes("application/json")) {
      throw new NotAcceptableError("Content-Type must be application/json");
    }
  };

  const getSecret = (): string => {
    return (
      opts.verifySecret ||
      (fastify as any).config?.messaging?.whatsappVerifySecret ||
      process.env.WHATSAPP_VERIFY_SECRET ||
      "whatsapp_webhook_verify_secret"
    );
  };

  // GET /webhooks/whatsapp — Meta Webhook Subscription Verification Handshake
  fastify.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, string | undefined>;
    const mode = query["hub.mode"];
    const token = query["hub.verify_token"];
    const challenge = query["hub.challenge"];

    const secret = getSecret();

    if (mode === "subscribe" && token === secret) {
      return reply.status(200).type("text/plain").send(challenge || "");
    }

    await recordWebhookAuthFailure(fastify, request, "WHATSAPP");
    return reply.status(403).send({ error: "Verification token mismatch" });
  });

  // POST /webhooks/whatsapp — Status Updates and Inbound Customer Replies
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
    async (request: FastifyRequest, reply: FastifyReply) => {
      const rawBody =
        (request as any).rawBody !== undefined
          ? (request as any).rawBody
          : typeof request.body === "string"
            ? request.body
            : JSON.stringify(request.body);

      const signature = request.headers["x-hub-signature-256"] as string | undefined;
      const secret = getSecret();

      // Signature Verification (Constant-Time HMAC-SHA256)
      if (signature) {
        const expectedHash = createHmac("sha256", secret).update(rawBody).digest("hex");
        const expectedSig = `sha256=${expectedHash}`;

        try {
          const sigBuffer = Buffer.from(signature, "utf8");
          const expectedBuffer = Buffer.from(expectedSig, "utf8");

          if (
            sigBuffer.length !== expectedBuffer.length ||
            !timingSafeEqual(sigBuffer, expectedBuffer)
          ) {
            await recordWebhookAuthFailure(fastify, request, "WHATSAPP");
            return reply.status(401).send({
              error: {
                code: "INVALID_SIGNATURE",
                message: "WhatsApp signature verification failed",
              },
            });
          }
        } catch {
          await recordWebhookAuthFailure(fastify, request, "WHATSAPP");
          return reply.status(401).send({
            error: {
              code: "INVALID_SIGNATURE",
              message: "WhatsApp signature verification failed",
            },
          });
        }
      } else if (process.env.NODE_ENV === "production") {
        await recordWebhookAuthFailure(fastify, request, "WHATSAPP");
        return reply.status(401).send({
          error: {
            code: "SIGNATURE_MISSING",
            message: "x-hub-signature-256 header is required",
          },
        });
      }

      const body = request.body as any;
      const entries = body?.entry || [];

      for (const entry of entries) {
        const changes = entry?.changes || [];
        for (const change of changes) {
          const value = change?.value;
          if (!value) continue;

          // 1. Process Status Receipts (delivered, read, failed, sent)
          const statuses = value.statuses || [];
          for (const st of statuses) {
            const providerMessageId = st.id;
            const rawStatus = (st.status || "").toLowerCase();
            const timestamp = st.timestamp ? new Date(Number(st.timestamp) * 1000) : new Date();

            let targetStatus: MessageStatus | null = null;
            if (rawStatus === "delivered") targetStatus = "DELIVERED";
            else if (rawStatus === "read") targetStatus = "READ";
            else if (rawStatus === "sent") targetStatus = "SENT";
            else if (rawStatus === "failed") targetStatus = "FAILED";

            if (!targetStatus || !providerMessageId) continue;

            const existingMsg = await fastify.repos.findMessageByProviderMessageId({ db: fastify.db }, {
              providerMessageId,
            });

            if (existingMsg) {
              const currentStatus = existingMsg.status;
              const isTerminal =
                currentStatus === "FAILED" ||
                currentStatus === "BOUNCED" ||
                currentStatus === "REJECTED";

              // Append delivery receipt
              await fastify.repos.recordDeliveryEvent({ db: fastify.db }, {
                messageId: existingMsg.id,
                status: targetStatus,
                occurredAt: timestamp,
                payload: {
                  provider: "WHATSAPP_CLOUD",
                  raw_status: rawStatus,
                  recipient_id: st.recipient_id,
                  errors: st.errors,
                },
              });

              // Apply transition if not already terminal
              if (!isTerminal && currentStatus !== targetStatus) {
                await fastify.repos.updateMessageStatus({ db: fastify.db }, {
                  tenantId: existingMsg.tenantId,
                  messageId: existingMsg.id,
                  status: targetStatus,
                  finalStatusAt: targetStatus === "FAILED" ? timestamp : undefined,
                });
              }
            }
          }

          // 2. Process Inbound Messages (Replies & Opt-outs)
          const messages = value.messages || [];
          for (const msg of messages) {
            const senderPhone = msg.from;
            const msgId = msg.id;
            const textBody =
              msg.text?.body ||
              msg.button?.text ||
              msg.interactive?.button_reply?.title ||
              "";

            const isOptOut = OPT_OUT_REGEX.test(textBody);
            let responseType: CustomerResponseType = "REPLY";
            if (isOptOut) {
              responseType = "OPT_OUT";
            } else if (PTP_REGEX.test(textBody)) {
              responseType = "PROMISE_TO_PAY";
            } else if (COMPLAINT_REGEX.test(textBody)) {
              responseType = "COMPLAINT";
            }

            // Find customer by phone
            const customer = await fastify.repos.findFirstCustomerByPhone({ db: fastify.db }, {
              phone: senderPhone,
            });

            if (customer) {
              // Opt-out handling: immediately set opted_out = true
              if (isOptOut) {
                await fastify.repos.setCustomerOptOut({ db: fastify.db }, {
                  tenantId: customer.tenantId,
                  customerId: customer.id,
                  optedOut: true,
                });

                request.log.info(
                  { customerId: customer.id, tenantId: customer.tenantId, phone: maskPhone(senderPhone) },
                  "Inbound STOP keyword processed: customer opted out",
                );
              }

              // Record customer response
              await fastify.repos.createCustomerResponse({ db: fastify.db }, {
                tenantId: customer.tenantId,
                customerId: customer.id,
                channel: "WHATSAPP",
                type: responseType,
                contentRedacted: isOptOut ? "STOP" : textBody.slice(0, 500),
                rawRef: msgId,
              });

              // Emit Domain Event on EventBus
              const eventType = isOptOut ? "customer.opted_out" : "customer.replied";
              const domainEvent: DomainEvent = {
                id: randomUUID(),
                type: eventType,
                occurred_at: new Date().toISOString(),
                source: "whatsapp",
                tenant_id: customer.tenantId,
                customer_id: customer.id,
                entity_id: customer.id,
                entity_type: "CUSTOMER",
                payload: {
                  customer_id: customer.id,
                  channel: "WHATSAPP",
                  response_type: responseType,
                  is_opt_out: isOptOut,
                  message_ref: msgId,
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
    },
  );
};
