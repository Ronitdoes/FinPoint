import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { processInboundWebhook } from "./ingest.service";
import { NotAcceptableError } from "../../lib/errors";
import { whatsappWebhookRoutes } from "../messaging/webhooks/whatsapp.routes";
import { emailWebhookRoutes } from "../messaging/webhooks/email.routes";

import { DEV_MOCK_STRIPE_WEBHOOK_SECRET, DEV_MOCK_RAZORPAY_WEBHOOK_SECRET } from "../demo/simulator.service";

export interface WebhookRouteOptions {
  stripeWebhookSecret?: string | null;
  razorpayWebhookSecret?: string | null;
}

/**
 * Event Gateway Webhook Ingestion Routes (POST /webhooks/stripe & /webhooks/razorpay).
 * Bypasses session/api-key auth; secured exclusively via provider signatures (Spec 01 §7, Spec 02 §14, s-10).
 */
export const webhooksRoutes: FastifyPluginAsync<WebhookRouteOptions> = async (
  fastify,
  opts,
) => {
  // Pre-handler hook to enforce application/json Content-Type (406 on mismatch)
  const validateContentType = async (request: FastifyRequest, _reply: FastifyReply) => {
    const contentType = request.headers["content-type"];
    if (!contentType || !contentType.toLowerCase().includes("application/json")) {
      throw new NotAcceptableError("Content-Type must be application/json");
    }
  };

  // Helper to extract raw body buffer/string
  const getRawBody = (request: FastifyRequest): string | Buffer => {
    if ((request as any).rawBody !== undefined) {
      return (request as any).rawBody;
    }
    if (typeof request.body === "string" || Buffer.isBuffer(request.body)) {
      return request.body;
    }
    return JSON.stringify(request.body);
  };

  // POST /webhooks/stripe
  fastify.post(
    "/stripe",
    {
      config: {
        rateLimit: {
          max: 600,
          timeWindow: "1 minute",
        },
      },
      preHandler: [validateContentType],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const rawBody = getRawBody(request);
      const query = request.query as Record<string, string | undefined>;

      const isMockMode = (fastify as any).config?.demo?.mockProviders === true;
      const rawStripeSecret =
        opts.stripeWebhookSecret ||
        (fastify as any).config?.payments?.stripeWebhookSecret ||
        process.env.STRIPE_WEBHOOK_SECRET;

      const stripeSecret =
        rawStripeSecret && rawStripeSecret.trim() !== ""
          ? rawStripeSecret
          : isMockMode
            ? DEV_MOCK_STRIPE_WEBHOOK_SECRET
            : undefined;

      const result = await processInboundWebhook(
        {
          db: fastify.db,
          repos: fastify.repos,
          eventBus: (fastify as any).eventBus,
          logger: request.log,
          stripeWebhookSecret: stripeSecret,
        },
        {
          provider: "STRIPE",
          rawBody,
          headers: request.headers,
          queryTenantId: query?.tenant_id,
          correlationId: request.correlationId,
          traceparent: request.traceparent,
        },
      );

      return reply.status(200).send(result);
    },
  );

  // POST /webhooks/razorpay
  fastify.post(
    "/razorpay",
    {
      config: {
        rateLimit: {
          max: 600,
          timeWindow: "1 minute",
        },
      },
      preHandler: [validateContentType],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const rawBody = getRawBody(request);
      const query = request.query as Record<string, string | undefined>;

      const isMockMode = (fastify as any).config?.demo?.mockProviders === true;
      const rawRazorpaySecret =
        opts.razorpayWebhookSecret ||
        (fastify as any).config?.payments?.razorpayWebhookSecret ||
        process.env.RAZORPAY_WEBHOOK_SECRET;

      const razorpaySecret =
        rawRazorpaySecret && rawRazorpaySecret.trim() !== ""
          ? rawRazorpaySecret
          : isMockMode
            ? DEV_MOCK_RAZORPAY_WEBHOOK_SECRET
            : undefined;

      const result = await processInboundWebhook(
        {
          db: fastify.db,
          repos: fastify.repos,
          eventBus: (fastify as any).eventBus,
          logger: request.log,
          razorpayWebhookSecret: razorpaySecret,
        },
        {
          provider: "RAZORPAY",
          rawBody,
          headers: request.headers,
          queryTenantId: query?.tenant_id,
          correlationId: request.correlationId,
          traceparent: request.traceparent,
        },
      );

      return reply.status(200).send(result);
    },
  );

  // Register Messaging status and inbound webhooks (s-19)
  await fastify.register(whatsappWebhookRoutes, { prefix: "/whatsapp" });
  await fastify.register(emailWebhookRoutes, { prefix: "/email" });
};

