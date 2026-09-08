import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { getTenantScope } from "../../plugins/auth";
import type { ListMessagesQuery } from "./types";
import { maskEmail, maskPhone } from "../customers/context/allowlist";
import { NotFoundError } from "../../lib/errors";
import { rateLimitFor } from "../../plugins/rate-limit-policy";

function maskRecipientAddress(address: string, channel: string): string {
  if (channel === "EMAIL") {
    return maskEmail(address) || address;
  }
  return maskPhone(address) || address;
}

function redactMessageVariables(
  variables: Record<string, unknown> = {},
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(variables)) {
    if (typeof value === "string" && (key.includes("token") || key.includes("secret") || key.includes("auth"))) {
      safe[key] = "[REDACTED]";
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

/**
 * Message Ledger Read Routes (Spec 01 §14, Spec 19 §API Contracts).
 * GET /messages & GET /messages/:id with RBAC role >= VIEWER and PII masking.
 */
export const messagingRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /messages — List messages for caller's tenant with filtering and pagination
  fastify.get(
    "/",
    {
      preHandler: [
        fastify.requireAuth,
        fastify.requireRole("VIEWER", "SUPPORT", "OPERATIONS", "FINANCE", "ADMIN"),
      ],
      config: {
        rateLimit: rateLimitFor("read"),
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getTenantScope(request);
      const query = request.query as ListMessagesQuery;

      const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100);
      const offset = Math.max(Number(query.offset) || 0, 0);

      const items = await fastify.repos.listMessages({ db: fastify.db }, {
        tenantId,
        caseId: query.case_id,
        customerId: query.customer_id,
        channel: query.channel,
        status: query.status,
        limit,
        offset,
      });

      const sanitizedItems = items.map((msg) => ({
        id: msg.id,
        tenant_id: msg.tenantId,
        case_id: msg.caseId,
        customer_id: msg.customerId,
        channel: msg.channel,
        direction: msg.direction,
        template_id: msg.templateId,
        to_address_masked: maskRecipientAddress(msg.toAddress, msg.channel),
        provider: msg.provider,
        provider_message_id: msg.providerMessageId,
        status: msg.status,
        variables: redactMessageVariables(msg.variables),
        sent_at: msg.sentAt,
        final_status_at: msg.finalStatusAt,
        created_at: msg.createdAt,
        updated_at: msg.updatedAt,
      }));

      return reply.status(200).send({
        items: sanitizedItems,
        pagination: {
          limit,
          offset,
          has_more: items.length === limit,
        },
      });
    },
  );

  // GET /messages/:id — Single message detail with delivery history timeline
  fastify.get(
    "/:id",
    {
      preHandler: [
        fastify.requireAuth,
        fastify.requireRole("VIEWER", "SUPPORT", "OPERATIONS", "FINANCE", "ADMIN"),
      ],
      config: {
        rateLimit: rateLimitFor("read"),
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getTenantScope(request);
      const { id } = request.params as { id: string };

      const message = await fastify.repos.findMessageById({ db: fastify.db }, {
        tenantId,
        messageId: id,
      });

      if (!message) {
        throw new NotFoundError(`Message with id '${id}' not found`);
      }

      const deliveryEvents = await fastify.repos.listDeliveryEvents({ db: fastify.db }, {
        messageId: message.id,
      });

      const sanitizedMessage = {
        id: message.id,
        tenant_id: message.tenantId,
        case_id: message.caseId,
        customer_id: message.customerId,
        channel: message.channel,
        direction: message.direction,
        template_id: message.templateId,
        to_address_masked: maskRecipientAddress(message.toAddress, message.channel),
        provider: message.provider,
        provider_message_id: message.providerMessageId,
        status: message.status,
        variables: redactMessageVariables(message.variables),
        sent_at: message.sentAt,
        final_status_at: message.finalStatusAt,
        created_at: message.createdAt,
        updated_at: message.updatedAt,
        delivery_events: deliveryEvents.map((evt) => ({
          id: evt.id,
          status: evt.status,
          occurred_at: evt.occurredAt,
          payload: evt.payload,
        })),
      };

      return reply.status(200).send(sanitizedMessage);
    },
  );
};
