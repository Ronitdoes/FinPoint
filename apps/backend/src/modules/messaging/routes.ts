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
    const lower = key.toLowerCase();
    if (
      lower.includes("token") ||
      lower.includes("secret") ||
      lower.includes("auth") ||
      lower.includes("password") ||
      lower.includes("payment_url") ||
      lower.includes("payment_link") ||
      lower.includes("checkout_url") ||
      lower.includes("invoice_number") ||
      lower.includes("amount") ||
      lower.includes("payment") ||
      lower.includes("checkout") ||
      lower.includes("invoice") ||
      lower.includes("url") ||
      lower.includes("link")
    ) {
      safe[key] = "[REDACTED]";
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

const DELIVERY_PAYLOAD_SENSITIVE_PATTERNS = [
  "token",
  "secret",
  "auth",
  "password",
  "payment_url",
  "payment_link",
  "checkout_url",
  "invoice_number",
  "amount",
  "payment",
  "checkout",
  "invoice",
  "url",
  "link",
];

const DELIVERY_PAYLOAD_ADDRESS_KEYS = [
  "recipient_id",
  "recipient",
  "to",
  "to_address",
  "phone",
  "email",
  "address",
];

/**
 * Recursively scrubs delivery-event payloads before returning them on
 * GET /messages/:id (s-19 audit fix): masks recipient/phone/email identifiers
 * and redacts payment URLs, invoice numbers, and amounts. Plain status fields
 * (provider, raw_status, raw_event, status) are preserved.
 */
export function scrubDeliveryEventPayload(payload: unknown): unknown {
  if (payload === null || payload === undefined) return payload;
  if (typeof payload === "string") {
    // Avoid leaking raw emails/phones embedded as bare strings at top level.
    const trimmed = payload.trim();
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) return maskEmail(trimmed) || "[REDACTED]";
    if (/^\+?\d[\d\s\-()]{6,}$/.test(trimmed)) return maskPhone(trimmed) || "[REDACTED]";
    return payload;
  }
  if (Array.isArray(payload)) return payload.map(scrubDeliveryEventPayload);
  if (typeof payload === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      if (DELIVERY_PAYLOAD_ADDRESS_KEYS.some((k) => lower === k || lower.includes(k))) {
        out[key] =
          typeof value === "string"
            ? (lower.includes("email") ? maskEmail(value) || "[REDACTED]" : maskPhone(value) || "[REDACTED]")
            : "[REDACTED]";
        continue;
      }
      if (DELIVERY_PAYLOAD_SENSITIVE_PATTERNS.some((p) => lower.includes(p))) {
        out[key] = "[REDACTED]";
        continue;
      }
      out[key] = scrubDeliveryEventPayload(value);
    }
    return out;
  }
  return payload;
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
          payload: scrubDeliveryEventPayload(evt.payload),
        })),
      };

      return reply.status(200).send(sanitizedMessage);
    },
  );
};
