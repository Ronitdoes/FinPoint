/**
 * Shared chaos seed helpers (Step 31).
 *
 * Every scenario runs against an isolated tenant so suites are hermetic and
 * parallel-safe. All financial rows use the MOCK provider — chaos never moves
 * real money.
 */
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../apps/backend/src/app";
import { apiConfig } from "@repo/config";
import { NullBus } from "@repo/integrations";
import { metricsRegistry } from "@repo/observability";
import {
  db,
  createTenant,
  createApiKey,
  createCustomer,
  createPayment,
  createRevenueRisk,
  createCase,
  type Tenant,
  type Customer,
  type Payment,
  type RevenueRisk,
  type RecoveryCase,
} from "@repo/db";

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function tag(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/** Builds the backend app wired for chaos: NullBus, no rate limits, quiet logs. */
export async function buildChaosApp(): Promise<{
  app: FastifyInstance;
  eventBus: NullBus;
}> {
  const eventBus = new NullBus();
  const app = await buildApp({
    eventBus,
    disableRateLimit: true,
    logger: false,
    config: apiConfig(),
  });
  await app.ready();
  return { app, eventBus };
}

export async function createChaosTenant(prefix: string): Promise<Tenant> {
  const id = tag(prefix);
  return await createTenant(
    { db },
    { name: `Chaos ${id}`, slug: `chaos-${id}` },
  );
}

export async function createChaosApiKey(
  tenantId: string,
  scopes: string[] = ["events:write"],
): Promise<string> {
  const rawKey = `rrk_${randomUUID().replace(/-/g, "")}`;
  await createApiKey(
    { db },
    {
      tenantId,
      name: `Chaos key ${randomUUID().slice(0, 8)}`,
      keyHash: sha256Hex(rawKey),
      scopes,
    },
  );
  return rawKey;
}

export async function createChaosCustomer(
  tenantId: string,
  prefix = "cus",
  overrides: { email?: string; phone?: string } = {},
): Promise<Customer> {
  const id = tag(prefix);
  return await createCustomer(
    { db },
    {
      tenantId,
      externalRef: `ext_${id}`,
      name: `Chaos Customer ${id}`,
      email: overrides.email ?? `${id}@chaos.example.com`,
      phone: overrides.phone ?? `+1555${Math.floor(100000 + Math.random() * 899999)}`,
    },
  );
}

export async function createChaosPayment(
  tenantId: string,
  customerId: string,
  prefix = "pay",
  overrides: {
    amount?: bigint;
    currency?: string;
    status?: "CREATED" | "PENDING" | "FAILED" | "SUCCEEDED";
    provider?: "STRIPE" | "RAZORPAY" | "MOCK";
    occurredAt?: Date;
  } = {},
): Promise<Payment> {
  const id = tag(prefix);
  return await createPayment(
    { db },
    {
      tenantId,
      customerId,
      amount: overrides.amount ?? 5000n,
      currency: overrides.currency ?? "USD",
      status: overrides.status ?? "FAILED",
      provider: overrides.provider ?? "MOCK",
      providerPaymentId: `mock_${id}`,
      occurredAt: overrides.occurredAt ?? new Date(),
    },
  );
}

export async function createChaosRisk(
  tenantId: string,
  customerId: string,
  subjectId: string,
): Promise<RevenueRisk> {
  return await createRevenueRisk(
    { db },
    {
      tenantId,
      customerId,
      riskType: "PAYMENT_FAILURE",
      subjectType: "PAYMENT",
      subjectId,
      score: 80,
      band: "HIGH",
      factors: { chaos: true },
      computedAt: new Date(),
    },
  );
}

export async function createChaosCase(
  tenantId: string,
  customerId: string,
  payment: Payment,
  overrides: {
    status?: RecoveryCase["status"];
    openedAt?: Date;
    riskId?: string;
  } = {},
): Promise<RecoveryCase> {
  return await createCase(
    { db },
    {
      tenantId,
      customerId,
      riskType: "PAYMENT_FAILURE",
      sourceEntityType: "PAYMENT",
      sourceEntityId: payment.id,
      amountAtRisk: payment.amount,
      currency: payment.currency,
      riskScore: 80,
      status: overrides.status,
      openedAt: overrides.openedAt,
      riskId: overrides.riskId,
    },
  );
}

/**
 * Full payment-anchored fixture: tenant → customer → payment → risk → case.
 * `caseOpenedAt` defaults to one hour before the payment so attribution
 * windows treat the payment as occurring after case opening.
 */
export async function createChaosPaymentCase(prefix: string): Promise<{
  tenant: Tenant;
  customer: Customer;
  payment: Payment;
  risk: RevenueRisk;
  recoveryCase: RecoveryCase;
}> {
  const tenant = await createChaosTenant(prefix);
  const customer = await createChaosCustomer(tenant.id);
  const payment = await createChaosPayment(tenant.id, customer.id, prefix, {
    occurredAt: new Date(),
  });
  const risk = await createChaosRisk(tenant.id, customer.id, payment.id);
  const recoveryCase = await createChaosCase(tenant.id, customer.id, payment, {
    status: "IN_PROGRESS",
    openedAt: new Date(Date.now() - 60 * 60 * 1000),
    riskId: risk.id,
  });
  return { tenant, customer, payment, risk, recoveryCase };
}

/**
 * Reads a Prometheus counter's current value for an exact label set.
 * Metrics are process-global, so chaos tests always assert before/after deltas.
 * (prom-client v15 exposes values via async `.get()`.)
 */
export async function counterValue(
  name: string,
  labels: Record<string, string> = {},
): Promise<number> {
  try {
    const metric = metricsRegistry.getSingleMetric(name) as any;
    if (!metric) return 0;
    const snapshot = (await metric.get()) as {
      values?: Array<{ labels: Record<string, string>; value: number }>;
    };
    let total = 0;
    for (const sample of snapshot.values ?? []) {
      const matches = Object.entries(labels).every(
        ([key, value]) => sample.labels[key] === value,
      );
      if (matches) total += sample.value;
    }
    return total;
  } catch {
    return 0;
  }
}

/** Polls `fn` until it returns a truthy value or the timeout elapses. */
export async function waitFor(
  fn: () => Promise<unknown>,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const { timeoutMs = 15000, intervalMs = 100, label = "condition" } = options;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `waitFor timed out after ${timeoutMs}ms: ${label}` +
      (lastError ? ` (last error: ${String(lastError)})` : ""),
  );
}
