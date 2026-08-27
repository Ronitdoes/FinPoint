import type Redis from "ioredis";
import { withSpan, recordContextBuild, getLogger } from "@repo/observability";
import type { Database } from "@repo/db";
import type { Repositories } from "../../../plugins/db";
import {
  CUSTOMER_CONTEXT_ALLOWLIST,
  projectAllowlist,
} from "./allowlist";
import {
  summarizeCustomerProfile,
  summarizePayments,
  summarizeSubscriptions,
  summarizeInvoices,
  summarizeCheckouts,
  summarizeRecoveryHistory,
  summarizeCommunicationHistory,
  summarizePreferences,
} from "./summarize";
import { trimContextToBudget, MAX_CONTEXT_BYTES } from "./trim";
import {
  CustomerContextSchema,
  type CustomerContext,
  type ContextPurpose,
} from "./types";
import { ContextUnavailableError, NotFoundError } from "../../../lib/errors";

const logger = getLogger({ component: "customer-context-builder" });

export interface BuildContextOptions {
  tenantId: string;
  customerId: string;
  purpose?: ContextPurpose;
  forceFresh?: boolean;
  now?: Date;
  db: Database;
  repos: Repositories;
  redis?: Redis | null;
}

export function getContextCacheKey(
  tenantId: string,
  customerId: string,
  purpose: ContextPurpose = "api_read",
): string {
  return `context:${tenantId}:${customerId}:${purpose}`;
}

/**
 * Builds the typed, allowlisted, size-bounded, tenant-isolated CustomerContext object.
 * Enforces Spec 01 §9, Spec 02 §2, Spec 03 §11, and s-13 requirements:
 * 1. Single-batch parallel queries across aggregate repositories (Promise.all).
 * 2. Strict allowlist projection via pure summarizers.
 * 3. Runtime contract validation via Zod strict schema.
 * 4. Deterministic <=8KB budget trimming.
 * 5. Redis caching (30s TTL, max stale 60s for ai_decision, graceful fallback on Redis failure).
 * 6. Observability: OpenTelemetry span `context.build` and Prometheus metrics.
 */
export async function buildCustomerContext(
  options: BuildContextOptions,
): Promise<CustomerContext> {
  const {
    tenantId,
    customerId,
    purpose = "api_read",
    forceFresh = false,
    now = new Date(),
    db,
    repos,
    redis,
  } = options;

  const startTime = Date.now();
  const cacheKey = getContextCacheKey(tenantId, customerId, purpose);

  // 1. Cache lookup in Redis (30s TTL)
  if (!forceFresh && redis) {
    try {
      const cachedRaw = await redis.get(cacheKey);
      if (cachedRaw) {
        const parsed = JSON.parse(cachedRaw);
        const validated = CustomerContextSchema.safeParse(parsed);
        if (validated.success) {
          const builtAtMs = new Date(validated.data.built_at).getTime();
          const ageMs = now.getTime() - builtAtMs;

          // ai_decision must never be served stale >60s
          if (purpose !== "ai_decision" || ageMs <= 60000) {
            const bytes = Buffer.byteLength(cachedRaw, "utf8");
            recordContextBuild(purpose, Date.now() - startTime, bytes);
            return validated.data;
          }
        }
      }
    } catch (err: any) {
      logger.warn(
        { err: err.message, tenantId, customerId, purpose },
        "Redis cache read failed for customer context, falling back to live build",
      );
    }
  }

  // 2. Build live context inside OpenTelemetry span
  return await withSpan(
    "context.build",
    {
      "customer.id": customerId,
      "tenant.id": tenantId,
      "context.purpose": purpose,
    },
    async (span) => {
      const repoCtx = { db };

      let customerRow;
      let payments;
      let subscriptions;
      let invoices;
      let checkouts;
      let cases;
      let messages;
      let responses;

      try {
        // Parallel repo batch in single Promise.all (<100ms p95 target)
        [
          customerRow,
          payments,
          subscriptions,
          invoices,
          checkouts,
          cases,
          messages,
          responses,
        ] = await Promise.all([
          repos.findCustomerById(repoCtx, { tenantId, customerId }),
          repos.listPaymentsForCustomer(repoCtx, { tenantId, customerId, limit: 100 }),
          repos.listSubscriptionsForCustomer(repoCtx, { tenantId, customerId, limit: 50 }),
          repos.listInvoicesForCustomer(repoCtx, { tenantId, customerId, limit: 50 }),
          repos.listCheckoutsForCustomer(repoCtx, { tenantId, customerId, limit: 50 }),
          repos.listCases(repoCtx, { tenantId, customerId, limit: 100 }),
          repos.listMessagesForCustomer(repoCtx, { tenantId, customerId, limit: 100 }),
          repos.listResponsesForCustomer(repoCtx, { tenantId, customerId, limit: 100 }),
        ]);
      } catch (err: any) {
        logger.error(
          { err: err.message, tenantId, customerId },
          "Database query failure during customer context assembly",
        );
        throw new ContextUnavailableError(
          "Customer context repository queries failed",
          { originalError: err.message },
        );
      }

      // Customer must exist for this tenant
      if (!customerRow) {
        throw new NotFoundError(`Customer '${customerId}' not found`);
      }

      // Fetch recovery outcomes if cases exist
      let outcomes: any[] = [];
      if (cases && cases.length > 0) {
        try {
          const caseIds = cases.map((c) => c.id);
          outcomes = await repos.findOutcomesByCaseIds(repoCtx, { tenantId, caseIds });
        } catch {
          // Non-fatal if outcomes table is empty/unreachable
          outcomes = [];
        }
      }

      // 3. Summarize sections with allowlist projections
      const customerProfile = projectAllowlist(
        summarizeCustomerProfile(customerRow, now),
        CUSTOMER_CONTEXT_ALLOWLIST.customer,
      );

      const paymentSummary = projectAllowlist(
        summarizePayments(payments ?? [], now),
        CUSTOMER_CONTEXT_ALLOWLIST.payment_summary,
      );

      const subscriptionSummary = projectAllowlist(
        summarizeSubscriptions(subscriptions ?? [], payments ?? [], now),
        CUSTOMER_CONTEXT_ALLOWLIST.subscription_summary,
      );

      const invoiceSummary = projectAllowlist(
        summarizeInvoices(invoices ?? [], now),
        CUSTOMER_CONTEXT_ALLOWLIST.invoice_summary,
      );

      const checkoutSummary = projectAllowlist(
        summarizeCheckouts(checkouts ?? [], now),
        CUSTOMER_CONTEXT_ALLOWLIST.checkout_summary,
      );

      const recoveryHistory = projectAllowlist(
        summarizeRecoveryHistory(cases ?? [], outcomes),
        CUSTOMER_CONTEXT_ALLOWLIST.recovery_history,
      );

      const communicationHistory = projectAllowlist(
        summarizeCommunicationHistory(messages ?? [], responses ?? [], customerRow, now),
        CUSTOMER_CONTEXT_ALLOWLIST.communication_history,
      );

      const preferences = projectAllowlist(
        summarizePreferences(customerRow, messages ?? []),
        CUSTOMER_CONTEXT_ALLOWLIST.preferences,
      );

      const rawContext = {
        built_at: now.toISOString(),
        customer: customerProfile,
        payment_summary: paymentSummary,
        subscription_summary: subscriptionSummary,
        invoice_summary: invoiceSummary,
        checkout_summary: checkoutSummary,
        recovery_history: recoveryHistory,
        communication_history: communicationHistory,
        preferences: preferences,
      };

      // 4. Validate through Zod strict schema contract
      const parsedContext = CustomerContextSchema.parse(rawContext);

      // 5. Deterministic size budget enforcement (<=8KB)
      const trimResult = trimContextToBudget(parsedContext);
      const finalContext = trimResult.context;
      const finalBytes = trimResult.bytes;
      const durationMs = Date.now() - startTime;

      span.setAttributes({
        "context.bytes": finalBytes,
        "context.duration_ms": durationMs,
        "context.trimmed": trimResult.trimmed,
      });

      if (finalBytes > MAX_CONTEXT_BYTES) {
        logger.warn(
          { tenantId, customerId, finalBytes, maxBytes: MAX_CONTEXT_BYTES },
          "Customer context exceeds 8KB budget after maximum trimming",
        );
      }

      // Record metrics
      recordContextBuild(purpose, durationMs, finalBytes);

      // 6. Cache into Redis for 30 seconds
      if (redis) {
        try {
          await redis.set(cacheKey, JSON.stringify(finalContext), "EX", 30);
        } catch (err: any) {
          logger.warn(
            { err: err.message, tenantId, customerId },
            "Redis cache write failed for customer context",
          );
        }
      }

      return finalContext;
    },
  );
}
