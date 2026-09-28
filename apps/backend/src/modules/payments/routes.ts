import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { resolvePaymentProvider } from "@repo/integrations";
import { NotFoundError, ValidationError } from "../../lib/errors";
import { rateLimitFor } from "../../plugins/rate-limit-policy";

const paymentParamsSchema = z.object({
  id: z.string().uuid("Payment ID must be a valid UUID"),
});

/**
 * Format payment entity into JSON-safe canonical response (converting BigInt amounts).
 */
function toPaymentResponse(payment: any) {
  return {
    id: payment.id,
    tenantId: payment.tenantId,
    customerId: payment.customerId,
    subscriptionId: payment.subscriptionId,
    amount: payment.amount.toString(),
    currency: payment.currency,
    status: payment.status,
    provider: payment.provider,
    providerPaymentId: payment.providerPaymentId,
    failureCode: payment.failureCode,
    failureMessage: payment.failureMessage,
    methodMetadata: payment.methodMetadata,
    occurredAt: payment.occurredAt?.toISOString?.() ?? payment.occurredAt,
    paidAt: payment.paidAt?.toISOString?.() ?? payment.paidAt,
    refundedAt: payment.refundedAt?.toISOString?.() ?? payment.refundedAt,
    disputedAt: payment.disputedAt?.toISOString?.() ?? payment.disputedAt,
    createdAt: payment.createdAt?.toISOString?.() ?? payment.createdAt,
    updatedAt: payment.updatedAt?.toISOString?.() ?? payment.updatedAt,
  };
}

/**
 * Format attempt entity into JSON-safe response.
 */
function toAttemptResponse(attempt: any) {
  return {
    id: attempt.id,
    tenantId: attempt.tenantId,
    paymentId: attempt.paymentId,
    attemptNumber: attempt.attemptNumber,
    initiatedBy: attempt.initiatedBy,
    idempotencyKey: attempt.idempotencyKey,
    status: attempt.status,
    providerReference: attempt.providerReference,
    failureCode: attempt.failureCode,
    error: attempt.error,
    requestedAt: attempt.requestedAt?.toISOString?.() ?? attempt.requestedAt,
    resolvedAt: attempt.resolvedAt?.toISOString?.() ?? attempt.resolvedAt,
    createdAt: attempt.createdAt?.toISOString?.() ?? attempt.createdAt,
    updatedAt: attempt.updatedAt?.toISOString?.() ?? attempt.updatedAt,
  };
}

/**
 * Payment Routes Plugin (Spec 18 §API Contracts).
 */
export const paymentRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /payments/:id — View canonical payment and attempts timeline (VIEWER+)
   */
  app.get(
    "/:id",
    {
      preHandler: [
        app.requireAuth,
        app.requireRole("VIEWER", "SUPPORT", "OPERATIONS", "FINANCE", "ADMIN"),
      ],
      config: {
        rateLimit: rateLimitFor("read"),
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = paymentParamsSchema.safeParse(request.params);
      if (!parseResult.success) {
        throw new ValidationError("Invalid payment ID parameter", {
          issues: parseResult.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const paymentId = parseResult.data.id;

      const payment = await app.repos.findPaymentById(
        { db: app.db },
        { tenantId: tenantScope.tenantId, paymentId },
      );

      if (!payment) {
        throw new NotFoundError("Payment not found", { paymentId });
      }

      const attempts = await app.repos.findPaymentAttemptsByPaymentId(
        { db: app.db },
        { tenantId: tenantScope.tenantId, paymentId },
      );

      return reply.status(200).send({
        payment: toPaymentResponse(payment),
        attempts: attempts.map(toAttemptResponse),
      });
    },
  );

  /**
   * GET /payments/:id/status — Live gateway status query (OPERATIONS+)
   */
  app.get(
    "/:id/status",
    {
      preHandler: [
        app.requireAuth,
        app.requireRole("OPERATIONS", "FINANCE", "ADMIN"),
      ],
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = paymentParamsSchema.safeParse(request.params);
      if (!parseResult.success) {
        throw new ValidationError("Invalid payment ID parameter", {
          issues: parseResult.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const paymentId = parseResult.data.id;

      const payment = await app.repos.findPaymentById(
        { db: app.db },
        { tenantId: tenantScope.tenantId, paymentId },
      );

      if (!payment) {
        throw new NotFoundError("Payment not found", { paymentId });
      }

      const adapter = resolvePaymentProvider({
        provider: payment.provider,
        paymentsConfig: app.config?.payments,
        demoConfig: app.config?.demo,
      });

      const liveStatus = await adapter.getPaymentStatus(payment.providerPaymentId);
      let refreshed = false;

      // If live provider status transitioned to SUCCEEDED/FAILED, sync DB
      if (liveStatus.status !== payment.status && (liveStatus.status === "SUCCEEDED" || liveStatus.status === "FAILED")) {
        await app.repos.updatePaymentStatus(
          { db: app.db },
          {
            tenantId: tenantScope.tenantId,
            paymentId,
            status: liveStatus.status,
            failureCode: liveStatus.failureCode,
            failureMessage: liveStatus.failureMessage,
            paidAt: liveStatus.paidAt,
          },
        );
        refreshed = true;

        // Fee capture (s-18 fix): previously returned in `details` only and
        // lost when resolution happened via this path. Best-effort link to
        // live PAYMENT case; never fails the status query.
        if (liveStatus.status === "SUCCEEDED" && liveStatus.fee) {
          try {
            const liveCase = await app.repos.findLiveCaseByObligation(
              { db: app.db },
              {
                tenantId: tenantScope.tenantId,
                sourceEntityType: "PAYMENT",
                sourceEntityId: paymentId,
              },
            );
            if (liveCase) {
              await app.repos.recordCostEntry(
                { db: app.db },
                {
                  tenantId: tenantScope.tenantId,
                  caseId: liveCase.id,
                  category: "PAYMENT_PROCESSING",
                  amount: liveStatus.fee.amount,
                  currency: liveStatus.fee.currency,
                  metadata: {
                    provider: payment.provider,
                    providerPaymentId: payment.providerPaymentId,
                    via: "status-sync",
                  },
                  incurredAt: new Date(),
                },
              );
            }
          } catch {
            // Best-effort only.
          }
        }
      }

      return reply.status(200).send({
        paymentId: payment.id,
        currentStatus: payment.status,
        providerStatus: liveStatus.status,
        refreshed,
        details: {
          id: liveStatus.id,
          status: liveStatus.status,
          providerReference: liveStatus.providerReference,
          failureCode: liveStatus.failureCode,
          failureMessage: liveStatus.failureMessage,
          fee: liveStatus.fee ? {
            amount: liveStatus.fee.amount.toString(),
            currency: liveStatus.fee.currency,
          } : undefined,
        },
      });
    },
  );
};

/**
 * NOTE (s-18 audit): the unauthenticated `demoMockPaymentRoutes` export was
 * removed. Live mock scripting lives at `POST /demo/mock/payments/:key/next-outcome`
 * behind `demoGuard` + rate-limit (s-30 fix). Do not re-add an unguarded route.
 */
