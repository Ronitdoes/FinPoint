import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { DEFAULT_WEBHOOK_TIMEOUT_MS } from "@repo/config";
import { processInboundWebhook } from "./ingest.service";
import { NotAcceptableError, UnmappablePayloadError } from "../../lib/errors";
import { whatsappWebhookRoutes } from "../messaging/webhooks/whatsapp.routes";
import { emailWebhookRoutes } from "../messaging/webhooks/email.routes";
import { checkIpBlock } from "../security/ip-block.service";
import { recordWebhookAuthFailure } from "../security/webhook-abuse";

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
  // s-07 §Technical Implementation: webhook 25s budget. The socket-level
  // `requestTimeout` is global-only (Node http server), so the longer budget
  // is enforced with Fastify v5's per-route `handlerTimeout`: app-level,
  // overrides the server default, 503s + aborts `request.signal` on expiry.
  // `config.requestTimeoutMs` mirrors the value for discoverability (the
  // spec's "route-level config.requestTimeoutMs") while `handlerTimeout` is
  // what actually enforces it — no Promise.race wrapper needed.
  const webhookTimeoutMs =
    (fastify as any).config?.http?.webhookTimeoutMs ??
    DEFAULT_WEBHOOK_TIMEOUT_MS;

  // Pre-handler hook to enforce application/json Content-Type (406 on mismatch)
  const validateContentType = async (request: FastifyRequest, _reply: FastifyReply) => {
    const contentType = request.headers["content-type"];
    if (!contentType || !contentType.toLowerCase().includes("application/json")) {
      throw new NotAcceptableError("Content-Type must be application/json");
    }
  };

  // Helper to extract raw body buffer/string.
  // s-10 audit fix (fail-closed): app.ts registers a buffer content-type parser
  // that ALWAYS sets request.rawBody for application/json, and the pre-handler
  // above rejects non-JSON content-types with 406 — so reaching this helper
  // without a rawBody means parser misconfiguration, not a provider edge case.
  // Re-serializing request.body via JSON.stringify would produce bytes that
  // differ from what the provider signed (key order/whitespace), silently
  // breaking signature trust; hence a 400 instead of a silent re-serialization.
  const getRawBody = (request: FastifyRequest): string | Buffer => {
    if ((request as any).rawBody !== undefined) {
      return (request as any).rawBody;
    }
    if (typeof request.body === "string" || Buffer.isBuffer(request.body)) {
      return request.body;
    }
    throw new UnmappablePayloadError(
      "Missing raw webhook body for signature verification",
    );
  };

  // POST /webhooks/stripe
  fastify.post(
    "/stripe",
    {
      handlerTimeout: webhookTimeoutMs,
      config: {
        rateLimit: {
          max: 600,
          timeWindow: "1 minute",
        },
        requestTimeoutMs: webhookTimeoutMs,
      },
      preHandler: [checkIpBlock, validateContentType],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const rawBody = getRawBody(request);
      const query = request.query as Record<string, string | undefined>;

      const isMockMode = (fastify as any).config?.demo?.mockProviders === true;
      // Typed-config first (CONVENTIONS §1); explicit route opts override for
      // tests. No raw process.env fallback — config is always decorated by
      // buildApp and validated fail-fast at boot.
      const rawStripeSecret =
        opts.stripeWebhookSecret ||
        (fastify as any).config?.payments?.stripeWebhookSecret;

      const stripeSecret =
        rawStripeSecret && rawStripeSecret.trim() !== ""
          ? rawStripeSecret
          : isMockMode
            ? DEV_MOCK_STRIPE_WEBHOOK_SECRET
            : undefined;

      try {
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
      } catch (err: any) {
        if (err?.code === "INVALID_SIGNATURE" || err?.statusCode === 401) {
          await recordWebhookAuthFailure(fastify, request, "STRIPE");
        }
        throw err;
      }
    },
  );

  // POST /webhooks/razorpay
  fastify.post(
    "/razorpay",
    {
      handlerTimeout: webhookTimeoutMs,
      config: {
        rateLimit: {
          max: 600,
          timeWindow: "1 minute",
        },
        requestTimeoutMs: webhookTimeoutMs,
      },
      preHandler: [checkIpBlock, validateContentType],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const rawBody = getRawBody(request);
      const query = request.query as Record<string, string | undefined>;

      const isMockMode = (fastify as any).config?.demo?.mockProviders === true;
      const rawRazorpaySecret =
        opts.razorpayWebhookSecret ||
        (fastify as any).config?.payments?.razorpayWebhookSecret;

      const razorpaySecret =
        rawRazorpaySecret && rawRazorpaySecret.trim() !== ""
          ? rawRazorpaySecret
          : isMockMode
            ? DEV_MOCK_RAZORPAY_WEBHOOK_SECRET
            : undefined;

      try {
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
      } catch (err: any) {
        if (err?.code === "INVALID_SIGNATURE" || err?.statusCode === 401) {
          await recordWebhookAuthFailure(fastify, request, "RAZORPAY");
        }
        throw err;
      }
    },
  );

  // Register Messaging status and inbound webhooks (s-19)
  await fastify.register(whatsappWebhookRoutes, { prefix: "/whatsapp" });
  await fastify.register(emailWebhookRoutes, { prefix: "/email" });
};

