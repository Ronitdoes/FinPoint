import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { MockPaymentProvider } from "@repo/integrations";
import {
  simulatePaymentFail,
  simulatePaymentSucceed,
  simulateCheckoutAbandon,
  simulateInvoiceOverdue,
} from "./simulator.service";
import {
  getDemoInjections,
  setDemoInjections,
} from "./injections";
import {
  ForbiddenError,
  ValidationError,
} from "../../lib/errors";

const paymentFailSchema = z.object({
  tenant_id: z.string().optional(),
  customer_ref: z.string().optional(),
  amount_minor: z.coerce.number().positive().optional(),
  provider: z.enum(["STRIPE", "RAZORPAY", "stripe", "razorpay"]).optional(),
});

const paymentSucceedSchema = z
  .object({
    tenant_id: z.string().optional(),
    payment_id: z.string().optional(),
    provider_payment_id: z.string().optional(),
  })
  .refine((data) => data.payment_id || data.provider_payment_id, {
    message: "Either payment_id or provider_payment_id must be provided",
  });

const checkoutAbandonSchema = z.object({
  tenant_id: z.string().optional(),
  customer_ref: z.string().optional(),
  cart_value_minor: z.coerce.number().positive().optional(),
  age_minutes: z.coerce.number().min(0).optional(),
});

const invoiceOverdueSchema = z.object({
  tenant_id: z.string().optional(),
  customer_ref: z.string().optional(),
  amount_minor: z.coerce.number().positive().optional(),
  days_overdue: z.coerce.number().min(0).optional(),
});

const patchInjectionsSchema = z.object({
  simulate_payment_timeout: z.boolean().optional(),
  simulate_message_failure: z.boolean().optional(),
  simulate_llm_failure: z.boolean().optional(),
  simulate_duplicate_webhook: z.boolean().optional(),
});

const mockOverrideParamsSchema = z.object({
  key: z.string().min(1),
});

const mockOverrideBodySchema = z.object({
  status: z.enum(["SUCCEEDED", "FAILED", "UNKNOWN", "ACCEPTED_ASYNC"]),
  failureCode: z.string().optional(),
  failureMessage: z.string().optional(),
  feeAmount: z.coerce.number().optional(),
  feeCurrency: z.string().optional(),
  delayMs: z.coerce.number().optional(),
});

/**
 * Demo Mode & Simulation Endpoints Plugin (Spec 03 §2, §3, §9, Step 29).
 */
export const demoRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Universal Demo Guard:
   * 1. Hard check MOCK_PROVIDERS !== false (410 MOCK_DISABLED if mock mode is turned off)
   * 2. Auth: OPERATIONS+ session (ADMIN/OPERATIONS/FINANCE) OR demo api-key with 'demo' scope
   */
  const demoGuard = async (request: FastifyRequest, reply: FastifyReply) => {
    if (app.config.demo?.mockProviders === false) {
      return reply.status(410).send({
        statusCode: 410,
        code: "MOCK_DISABLED",
        error: "Gone",
        message: "Demo and simulation endpoints are disabled when MOCK_PROVIDERS=false",
      });
    }

    await app.requireAuth(request, reply);

    if (request.auth?.kind === "api_key") {
      const scopes = request.auth.scopes ?? [];
      const hasWildcard = scopes.includes("*");
      const hasDemo = scopes.includes("demo");
      if (!hasWildcard && !hasDemo) {
        throw new ForbiddenError(
          "Forbidden: API key missing required scope: demo",
        );
      }
    } else if (request.auth?.kind === "session") {
      const role = request.auth.role;
      if (!["OPERATIONS", "ADMIN", "FINANCE"].includes(role)) {
        throw new ForbiddenError(
          `Forbidden: Role '${role}' is not authorized for demo operations (OPERATIONS+ required)`,
        );
      }
    } else {
      throw new ForbiddenError("Forbidden: Authentication required");
    }
  };

  /**
   * POST /demo/payment-fail
   * Synthesizes customer+payment if needed and dispatches a signed failure webhook
   * to own /webhooks/{provider} endpoint.
   */
  app.post(
    "/payment-fail",
    { preHandler: [demoGuard] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = paymentFailSchema.safeParse(request.body || {});
      if (!parseResult.success) {
        throw new ValidationError(
          "Invalid payment-fail simulation payload",
          parseResult.error.issues,
        );
      }

      const tenantScope = app.getTenantScope(request);
      const tenantId = parseResult.data.tenant_id || tenantScope.tenantId;

      const result = await simulatePaymentFail(app, {
        tenantId,
        customerRef: parseResult.data.customer_ref,
        amountMinor: parseResult.data.amount_minor,
        provider: parseResult.data.provider,
      });

      return reply.status(200).send(result);
    },
  );

  /**
   * POST /demo/payment-succeed
   * Generates a signed payment success webhook and dispatches workflow signals.
   */
  app.post(
    "/payment-succeed",
    { preHandler: [demoGuard] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = paymentSucceedSchema.safeParse(request.body || {});
      if (!parseResult.success) {
        throw new ValidationError(
          "Invalid payment-succeed simulation payload",
          parseResult.error.issues,
        );
      }

      const tenantScope = app.getTenantScope(request);
      const tenantId = parseResult.data.tenant_id || tenantScope.tenantId;

      const result = await simulatePaymentSucceed(app, {
        tenantId,
        paymentId: parseResult.data.payment_id,
        providerPaymentId: parseResult.data.provider_payment_id,
      });

      return reply.status(200).send(result);
    },
  );

  /**
   * POST /demo/checkout-abandon
   * Creates checkout.started via POST /events, then forces abandonment event to advance timer state.
   */
  app.post(
    "/checkout-abandon",
    { preHandler: [demoGuard] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = checkoutAbandonSchema.safeParse(request.body || {});
      if (!parseResult.success) {
        throw new ValidationError(
          "Invalid checkout-abandon simulation payload",
          parseResult.error.issues,
        );
      }

      const tenantScope = app.getTenantScope(request);
      const tenantId = parseResult.data.tenant_id || tenantScope.tenantId;

      const authHeaders: Record<string, string> = {};
      if (request.headers.authorization) {
        authHeaders.authorization = request.headers.authorization;
      }
      if (request.headers.cookie) {
        authHeaders.cookie = request.headers.cookie;
      }

      const result = await simulateCheckoutAbandon(app, {
        tenantId,
        customerRef: parseResult.data.customer_ref,
        cartValueMinor: parseResult.data.cart_value_minor,
        ageMinutes: parseResult.data.age_minutes,
        authHeaders,
      });

      return reply.status(200).send(result);
    },
  );

  /**
   * POST /demo/invoice-overdue
   * Dispatches signed invoice.payment_failed webhook to own /webhooks/stripe endpoint.
   */
  app.post(
    "/invoice-overdue",
    { preHandler: [demoGuard] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = invoiceOverdueSchema.safeParse(request.body || {});
      if (!parseResult.success) {
        throw new ValidationError(
          "Invalid invoice-overdue simulation payload",
          parseResult.error.issues,
        );
      }

      const tenantScope = app.getTenantScope(request);
      const tenantId = parseResult.data.tenant_id || tenantScope.tenantId;

      const result = await simulateInvoiceOverdue(app, {
        tenantId,
        customerRef: parseResult.data.customer_ref,
        amountMinor: parseResult.data.amount_minor,
        daysOverdue: parseResult.data.days_overdue,
      });

      return reply.status(200).send(result);
    },
  );

  /**
   * PATCH /demo/injections
   * Sets runtime failure-injection toggles in Redis with 15-minute TTL.
   */
  app.patch(
    "/injections",
    { preHandler: [demoGuard] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = patchInjectionsSchema.safeParse(request.body || {});
      if (!parseResult.success) {
        throw new ValidationError(
          "Invalid injections payload",
          parseResult.error.issues,
        );
      }

      const result = await setDemoInjections(
        (app as any).redisClient,
        parseResult.data,
        app.config.demo,
      );

      return reply.status(200).send({
        ok: true,
        injections: result.injections,
        ttlSeconds: result.ttlSeconds,
      });
    },
  );

  /**
   * GET /demo/injections
   * Retrieves active runtime failure-injection toggles and remaining TTL.
   */
  app.get(
    "/injections",
    { preHandler: [demoGuard] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const result = await getDemoInjections(
        (app as any).redisClient,
        app.config.demo,
      );

      return reply.status(200).send({
        ok: true,
        injections: result.injections,
        source: result.source,
        ttlSeconds: result.ttlSeconds,
      });
    },
  );

  /**
   * POST /demo/mock/payments/:key/next-outcome
   * Scripted outcome override for MockPaymentProvider (retained from Step 18).
   */
  app.post(
    "/mock/payments/:key/next-outcome",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = mockOverrideParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        throw new ValidationError("Invalid key parameter", {
          issues: paramsResult.error.issues,
        });
      }

      const bodyResult = mockOverrideBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        throw new ValidationError("Invalid body payload", {
          issues: bodyResult.error.issues,
        });
      }

      const key = paramsResult.data.key;
      const data = bodyResult.data;

      MockPaymentProvider.setOutcomeOverride(key, {
        status: data.status,
        failureCode: data.failureCode,
        failureMessage: data.failureMessage,
        feeAmount: data.feeAmount !== undefined ? BigInt(data.feeAmount) : undefined,
        feeCurrency: data.feeCurrency,
        delayMs: data.delayMs,
      });

      return reply.status(200).send({
        success: true,
        key,
        configured: data,
      });
    },
  );
};
