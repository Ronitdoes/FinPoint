/**
 * Chaos scenario: WhatsApp timeout / dispatch failure (Spec 01 §21).
 *
 * The provider fails the first dispatch; the ledger must record exactly one
 * FAILED row (never a phantom SENT), and a retry under a fresh step key must
 * deliver exactly once — no double contact for the same idempotency key.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { db, findMessageByIdempotencyKey, listMessagesForCase } from "@repo/db";
import { MockMessagingProvider } from "@repo/integrations";
import { sendCaseMessage } from "../../../apps/backend/src/modules/messaging/send.service";
import { resetChaosHarness } from "../harness/fault-points";
import { assertInvariants } from "../harness/assert-invariants";
import {
  buildChaosApp,
  createChaosCase,
  createChaosCustomer,
  createChaosPayment,
  createChaosTenant,
} from "../harness/seed";

const VARIABLES = {
  customer_name: "Chaos WA",
  amount: "50.00",
  currency: "USD",
  payment_link: "https://pay.chaos.example/l/1",
  due_date: "2026-09-30",
};

describe("chaos: WhatsApp dispatch failure", { timeout: 60000 }, () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildChaosApp());
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  afterEach(() => {
    resetChaosHarness();
  });

  it("failed dispatch marks FAILED once; retry with new key sends exactly once", async () => {
    const tenant = await createChaosTenant("whatsapptimeout");
    const tenantId = tenant.id;
    const customer = await createChaosCustomer(tenantId);
    const payment = await createChaosPayment(tenantId, customer.id, "wa");
    const recoveryCase = await createChaosCase(tenantId, customer.id, payment, {
      status: "IN_PROGRESS",
    });

    const deps = {
      db: app.db,
      repos: app.repos,
      messagingConfig: null,
      demoConfig: null,
      customAdapter: new MockMessagingProvider({ simulateFailure: true }),
    };

    // 1. Dispatch fails: ledger records FAILED, error propagates (no phantom SENT).
    await expect(
      sendCaseMessage(deps, {
        tenantId,
        caseId: recoveryCase.id,
        customerId: customer.id,
        channel: "WHATSAPP",
        templateId: "payment_retry_notice",
        variables: VARIABLES,
        step: 1,
      }),
    ).rejects.toThrow();

    const failedKey = `${tenantId}:${recoveryCase.id}:WHATSAPP:payment_retry_notice:1`;
    const failedRow = await findMessageByIdempotencyKey(
      { db },
      { tenantId, idempotencyKey: failedKey },
    );
    expect(failedRow).toBeDefined();
    expect(failedRow!.status).toBe("FAILED");

    // 2. Same-key redelivery never re-dispatches (anti-double-send fast path).
    MockMessagingProvider.clearHistory();
    const sameKey = await sendCaseMessage(
      {
        db: app.db,
        repos: app.repos,
        messagingConfig: null,
        demoConfig: null,
        customAdapter: new MockMessagingProvider(),
      },
      {
        tenantId,
        caseId: recoveryCase.id,
        customerId: customer.id,
        channel: "WHATSAPP",
        templateId: "payment_retry_notice",
        variables: VARIABLES,
        step: 1,
      },
    );
    expect(sameKey.isDuplicate).toBe(true);
    expect(sameKey.messageId).toBe(failedRow!.id);
    expect(MockMessagingProvider.getSentHistory()).toHaveLength(0);

    // 3. Retry under a fresh step key delivers exactly once.
    MockMessagingProvider.clearHistory();
    const retry = await sendCaseMessage(
      {
        db: app.db,
        repos: app.repos,
        messagingConfig: null,
        demoConfig: null,
        customAdapter: new MockMessagingProvider(),
      },
      {
        tenantId,
        caseId: recoveryCase.id,
        customerId: customer.id,
        channel: "WHATSAPP",
        templateId: "payment_retry_notice",
        variables: VARIABLES,
        step: 2,
      },
    );
    expect(retry.status).toBe("SENT");
    expect(retry.isDuplicate).not.toBe(true);
    expect(MockMessagingProvider.getSentHistory()).toHaveLength(1);

    // Ledger holds exactly the FAILED + SENT rows — no duplicates.
    const ledger = await listMessagesForCase(
      { db },
      { tenantId, caseId: recoveryCase.id },
    );
    expect(ledger).toHaveLength(2);

    await assertInvariants(tenantId);
  });
});
