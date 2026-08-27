import type Redis from "ioredis";
import type { Database } from "@repo/db";
import type { Repositories } from "../../plugins/db";
import { getLogger } from "@repo/observability";
import {
  buildCustomerContext,
  getContextCacheKey,
  type BuildContextOptions,
} from "./context/builder";
import type { CustomerContext, ContextPurpose } from "./context/types";
import { CaseNotFoundError, CustomerMissingError } from "../../lib/errors";

const logger = getLogger({ component: "customer-context-service" });

export interface BuildForCaseOptions {
  tenantId: string;
  caseId: string;
  purpose?: ContextPurpose;
  forceFresh?: boolean;
  now?: Date;
  db: Database;
  repos: Repositories;
  redis?: Redis | null;
}

export class CustomerContextService {
  /**
   * Builds the customer context directly for a given customer.
   */
  public static async build(options: BuildContextOptions): Promise<CustomerContext> {
    return await buildCustomerContext(options);
  }

  /**
   * Internal API used by AI decisioning (Spec 01 §10, s-13, s-14):
   * Resolves case -> customer, then builds with purpose = 'ai_decision'.
   * Throws CASE_NOT_FOUND if case does not exist or belongs to another tenant.
   * Throws CUSTOMER_MISSING if customer id is missing on the case.
   */
  public static async buildForCase(
    options: BuildForCaseOptions,
  ): Promise<CustomerContext> {
    const {
      tenantId,
      caseId,
      purpose = "ai_decision",
      forceFresh = false,
      now = new Date(),
      db,
      repos,
      redis,
    } = options;

    const recoveryCase = await repos.findCaseById({ db }, { tenantId, caseId });
    if (!recoveryCase) {
      throw new CaseNotFoundError(`Recovery case '${caseId}' not found`);
    }

    if (!recoveryCase.customerId) {
      throw new CustomerMissingError(
        `Recovery case '${caseId}' has no associated customer`,
      );
    }

    return await buildCustomerContext({
      tenantId,
      customerId: recoveryCase.customerId,
      purpose,
      forceFresh,
      now,
      db,
      repos,
      redis,
    });
  }

  /**
   * Explicit cache invalidation helper (called when opt-out changes, message is sent, or outcome is recorded).
   */
  public static async invalidateCache(
    redis: Redis | null | undefined,
    tenantId: string,
    customerId: string,
  ): Promise<void> {
    if (!redis) return;
    try {
      const keys = [
        getContextCacheKey(tenantId, customerId, "api_read"),
        getContextCacheKey(tenantId, customerId, "ai_decision"),
      ];
      await redis.del(...keys);
    } catch (err: any) {
      logger.warn(
        { err: err.message, tenantId, customerId },
        "Failed to invalidate customer context cache in Redis",
      );
    }
  }
}
