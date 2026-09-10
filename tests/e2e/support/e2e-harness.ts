/**
 * Shared e2e harness (s-32 §Prerequisites: s-31 utilities reused).
 *
 * Boots the real Fastify API (`buildApp`) with the in-process bus driver
 * against the shared Postgres/Redis, seeds a minimal deterministic fixture
 * set (isolated tenant per test — the fast-path analog of "fresh volumes"),
 * and exposes polling/counter helpers.
 *
 * No test-only backdoors: all assertions go through public HTTP routes
 * (+/demo/* simulation endpoints) or existing repository readers.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import Redis from "ioredis";
import { buildApp } from "../../../apps/backend/src/app";
import { InProcessEventBus } from "@repo/integrations";
import { metricsRegistry } from "@repo/observability";
import { apiConfig } from "@repo/config";
import {
  db,
  createTenant,
  createUser,
  createSession,
  createCustomer,
  createPayment,
  type Tenant,
} from "@repo/db";
import { sha256 } from "../../../apps/backend/src/lib/crypto";
import { PolicyService } from "../../../apps/backend/src/modules/cases/../policy/policy.service";

export const E2E_AMOUNTS = {
  /** ₹12,999 in paise (minor units, ADR-009). Step text "12999" = rupees. */
  scenarioAminor: 1299900,
  scenarioBminor: 799900,
  scenarioCminor: 48000000,
} as const;

export interface E2EContext {
  app: FastifyInstance;
  eventBus: InProcessEventBus;
  redis: Redis | null;
  tenant: Tenant;
  adminCookie: string;
  financeCookie: string;
  viewerCookie: string;
  runId: string;
}

/**
 * Isolated Redis for the e2e project (s-32 §Reliability).
 *
 * Failure-injection flags (`/demo/injections`) are GLOBAL Redis keys shared
 * across suites: unit tests (e.g. s-29 demo-simulation) set
 * `simulate_llm_failure=true` with a 15m TTL, which would otherwise leak into
 * e2e journeys running concurrently and flip COMPLETED decisions to
 * FALLBACK. E2E apps therefore connect to logical DB index 1 (unit/infra
 * default is 0) and flush it on boot — nothing cross-file-persistent lives
 * there (tenant caches rebuild on miss). Returns null when Redis is
 * unreachable; the app's graceful-degraded paths then apply deterministically.
 */
async function createIsolatedRedis(): Promise<Redis | null> {
  let base: string | undefined;
  try {
    base = apiConfig().redis?.url;
  } catch {
    base = process.env.REDIS_URL;
  }
  if (!base) return null;
  let dbUrl = base;
  try {
    const parsed = new URL(base);
    parsed.pathname = "/1";
    dbUrl = parsed.toString();
  } catch {
    // Keep the configured URL verbatim if it is not parseable.
  }
  const client = new Redis(dbUrl, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times) => (times > 2 ? null : 150),
    lazyConnect: true,
  });
  client.on("error", () => {});
  try {
    await client.ping();
    await client.flushdb();
    return client;
  } catch {
    try {
      client.disconnect();
    } catch {
      // ignore teardown errors
    }
    return null;
  }
}

/**
 * Deterministic mock LLM: schema-valid COMPLETED decision with 0.86-parity
 * confidence (step §Requirements 2 item 8). Mirrors the s-17 integration mock.
 */
export const mockLlmFetch: any = async (_input: any, init: any) => {
  const body = init?.body ? JSON.parse(init.body as string) : {};
  const bodyStr = JSON.stringify(body);
  const optedOut =
    bodyStr.includes('opted_out": true') || bodyStr.includes('optedOut": true');
  const actions = optedOut
    ? [
        { type: "SEND_EMAIL", delay_hours: 2, params: { template: "payment_failed_notice", variables: {} } },
        { type: "SEND_WHATSAPP", delay_hours: 4, params: { template: "payment_reminder", variables: {} } },
      ]
    : [
        { type: "RETRY_PAYMENT", delay_hours: 2, params: { attempt_number: 1 } },
        {
          type: "SEND_WHATSAPP",
          delay_hours: 1,
          params: {
            template: "payment_retry_notice",
            variables: {
              customer_name: "E2E Customer",
              amount: "12999",
              currency: "INR",
              payment_link: "https://pay.example.com/e2e",
              due_date: "2026-09-30",
            },
          },
        },
      ];
  return new Response(
    JSON.stringify({
      id: "e2e-llm-choice-1",
      model: "gpt-4o-mini",
      choices: [
        {
          message: {
            role: "assistant",
            content: JSON.stringify({
              diagnosis: {
                cause: "insufficient_funds",
                confidence: 0.86,
                rationale: "E2E parity fixture: card declined for insufficient funds",
              },
              actions,
              stop_conditions: ["PAYMENT_SUCCEEDED", "OPTED_OUT", "MAX_RETRIES"],
            }),
          },
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};

/** Transport-level failure injector: forces FALLBACK_RULE_BASED (AI-outage mode). */
export const failingLlmFetch: any = async () => {
  throw new Error("E2E simulated upstream LLM outage");
};

/**
 * Global fetch stub routing ONLY LLM chat-completion traffic to the mock
 * model (background consumers build their own pipeline service without a
 * customFetch hook, so without this the real OpenAI endpoint burns ~20s of
 * retries per case before falling back). All non-LLM traffic delegates to the
 * original fetch. Vitest isolates files, so stubs never leak across suites.
 */
const LLM_PATH = "/chat/completions";
let originalFetch: typeof fetch | null = null;
let stubImpl: any = mockLlmFetch;

export function installE2ELlmStub(impl: any = mockLlmFetch): void {
  if (!originalFetch) {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : ((input as any)?.url ?? "");
      if (String(url).includes(LLM_PATH)) {
        return stubImpl(input, init);
      }
      return (originalFetch as typeof fetch)(input as any, init as any);
    }) as typeof fetch;
  }
  stubImpl = impl;
}

export function restoreE2EFetch(): void {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
}

async function createSessionCookie(tenantId: string, role: "ADMIN" | "FINANCE" | "VIEWER"): Promise<string> {
  const user = await createUser(
    { db },
    {
      tenantId,
      email: `${role.toLowerCase()}.e2e.${randomUUID().slice(0, 8)}@example.com`,
      name: `E2E ${role}`,
      passwordHash: "dummy-e2e",
      role,
      status: "ACTIVE",
    },
  );
  const rawToken = randomUUID();
  await createSession(
    { db },
    { userId: user.id, tokenHash: sha256(rawToken), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
  );
  return `rr_session=${rawToken}`;
}

/**
 * Boots the composed-stack fast path: real API + in-process bus + mock
 * providers, minimal deterministic fixtures, seeded platform policies.
 */
export async function buildE2EContext(prefix = "e2e"): Promise<E2EContext> {
  const runId = randomUUID().slice(0, 8);
  installE2ELlmStub(mockLlmFetch);
  const eventBus = new InProcessEventBus();
  const redis = await createIsolatedRedis();
  const tenant = await createTenant(
    { db },
    { name: `E2E ${prefix} ${runId}`, slug: `e2e-${prefix}-${runId}`.toLowerCase() },
  );
  const app = await buildApp({ eventBus, redisClient: redis ?? null, disableRateLimit: true, logger: false });
  await app.ready();

  const policyService = new PolicyService(db, (app as any).repos);
  await policyService.seedDefaultPolicies();

  const [adminCookie, financeCookie, viewerCookie] = await Promise.all([
    createSessionCookie(tenant.id, "ADMIN"),
    createSessionCookie(tenant.id, "FINANCE"),
    createSessionCookie(tenant.id, "VIEWER"),
  ]);
  return { app, eventBus, redis, tenant, adminCookie, financeCookie, viewerCookie, runId };
}

export async function closeE2EContext(ctx: E2EContext): Promise<void> {
  await new Promise((r) => setTimeout(r, 300));
  await ctx.app.close();
  if (ctx.redis) {
    try {
      ctx.redis.disconnect();
    } catch {
      // ignore teardown errors
    }
  }
  restoreE2EFetch();
}

/**
 * Pre-seeds payment history for `externalRef` so the journey's payment-failure
 * scores HIGH (deterministic rule math, s-12 weights):
 * failed≥2 (+40) + customer_active (+10) + ≥3 successes in 180d (+10) = 60.
 * Keeps the suite fast without the full s-29 volume.
 */
export async function seedPriorFailure(
  ctx: E2EContext,
  externalRef: string,
  amountMinor = 500000,
): Promise<void> {
  const customer = await createCustomer(
    { db },
    {
      tenantId: ctx.tenant.id,
      externalRef,
      name: `${externalRef} (E2E history)`,
      email: `${externalRef.toLowerCase()}@example.com`,
      phone: `+9198765${String(10000 + Math.floor(Math.random() * 89999))}`,
    },
  );
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await createPayment(
    { db },
    {
      tenantId: ctx.tenant.id,
      customerId: customer.id,
      provider: "STRIPE",
      providerPaymentId: `pi_e2e_hist_${ctx.runId}_${randomUUID().slice(0, 6)}`,
      amount: BigInt(amountMinor),
      currency: "INR",
      status: "FAILED",
      occurredAt: dayAgo,
    },
  );
  for (let i = 0; i < 3; i++) {
    const paidAt = new Date(Date.now() - (i + 2) * 24 * 60 * 60 * 1000);
    await createPayment(
      { db },
      {
        tenantId: ctx.tenant.id,
        customerId: customer.id,
        provider: "STRIPE",
        providerPaymentId: `pi_e2e_paid_${ctx.runId}_${i}_${randomUUID().slice(0, 6)}`,
        amount: BigInt(amountMinor),
        currency: "INR",
        status: "SUCCEEDED",
        occurredAt: paidAt,
        paidAt,
      },
    );
  }
}

/** Polls `fn` until truthy or timeout. Readiness-only retry point. */export async function waitFor(
  fn: () => Promise<unknown>,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const { timeoutMs = 20000, intervalMs = 150, label = "condition" } = options;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `waitFor timed out after ${timeoutMs}ms: ${label}` +
      (lastError ? ` (last error: ${String(lastError)})` : ""),
  );
}

/** Reads a prom-client counter's current value for an exact label set (delta-safe). */export async function counterValue(name: string, labels: Record<string, string> = {}): Promise<number> {
  try {
    const metric = metricsRegistry.getSingleMetric(name) as any;
    if (!metric) return 0;
    const snapshot = (await metric.get()) as {
      values?: Array<{ labels: Record<string, string>; value: number }>;
    };
    let total = 0;
    for (const sample of snapshot.values ?? []) {
      if (Object.entries(labels).every(([k, v]) => sample.labels[k] === v)) total += sample.value;
    }
    return total;
  } catch {
    return 0;
  }
}

export { db };

/**
 * Lets the background orchestrator (case.opened consumer) settle the staged
 * pipeline first; drives it explicitly exactly once only if the background
 * missed it (killed bus, pratfall). Never races the background: concurrent
 * `runPipeline` calls collide on the decision idempotency lease and poison
 * the case to FAILED, so explicit driving is strictly a fallback.
 */
export async function ensurePipelineSettled(
  ctx: E2EContext,
  caseId: string,
  opts: { timeoutMs?: number; customFetch?: any } = {},
): Promise<any> {
  const { findCaseById } = await import("@repo/db");
  try {
    await waitFor(
      async () => {
        const c = await findCaseById({ db }, { tenantId: ctx.tenant.id, caseId });
        return !!c && !["DETECTED", "QUALIFIED", "DECISION_PENDING", "POLICY_REVIEW"].includes(c.status);
      },
      { timeoutMs: opts.timeoutMs ?? 60000, intervalMs: 300, label: "background pipeline settle" },
    );
  } catch {
    const { CasePipelineService } = await import(
      "../../../apps/backend/src/modules/cases/pipeline.service"
    );
    const pipeline = new CasePipelineService({
      db: ctx.app.db,
      repos: ctx.app.repos,
      config: ctx.app.config,
      customFetch: opts.customFetch,
    });
    await pipeline.runPipeline({ tenantId: ctx.tenant.id, caseId });
  }
  return findCaseById({ db }, { tenantId: ctx.tenant.id, caseId });
}
