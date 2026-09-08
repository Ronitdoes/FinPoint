/**
 * Chaos scenario: customer opts out midway (Spec 01 §21).
 *
 * Round 1 delivers; the customer then opts out (STOP keyword path) before
 * round 2. Acceptance: remaining sends are suppressed with CUSTOMER_OPTED_OUT,
 * no new ledger rows appear for the suppressed round, and the workflow stops
 * cleanly.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { db, findCaseById, listMessagesForCase, setCustomerOptOut, transitionCaseStatus } from "@repo/db";
import { MockMessagingProvider } from "@repo/integrations";
import {
  CustomerOptedOutError,
  sendCaseMessage,
} from "../../../apps/backend/src/modules/messaging/send.service";
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
  customer_name: "Chaos Opt",
  amount: "75.00",
  currency: "USD",
  payment_link: "https://pay.chaos.example/l/2",
  due_date: "2026-09-30",
};

describe("chaos: customer opts out midway", { timeout: 60000 }, () => {
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

  it("round-2 sends suppressed after opt-out; workflow stops cleanly", async () => {
    const tenant = await createChaosTenant("optout");
    const tenantId = tenant.id;
    const customer = await createChaosCustomer(tenantId);
    const payment = await createChaosPayment(tenantId, customer.id, "optout");
    const recoveryCase = await createChaosCase(tenantId, customer.id, payment, {
      status: "IN_PROGRESS",
    });

    const deps = () => ({
      db: app.db,
      repos: app.repos,
      messagingConfig: null,
      demoConfig: null,
      customAdapter: new MockMessagingProvider(),
    });

    // Round 1 delivers before the opt-out.
    const round1 = await sendCaseMessage(deps(), {
      tenantId,
      caseId: recoveryCase.id,
      customerId: customer.id,
      channel: "WHATSAPP",
      templateId: "payment_retry_notice",
      variables: VARIABLES,
      step: 1,
    });
    expect(round1.status).toBe("SENT");

    // Customer opts out midway (STOP keyword automation equivalent).
    await setCustomerOptOut({ db }, { tenantId, customerId: customer.id, optedOut: true });

    // Round 2 is suppressed — never reaches the provider.
    MockMessagingProvider.clearHistory();
    await expect(
      sendCaseMessage(deps(), {
        tenantId,
        caseId: recoveryCase.id,
        customerId: customer.id,
        channel: "WHATSAPP",
        templateId: "payment_retry_notice",
        variables: VARIABLES,
        step: 2,
      }),
    ).rejects.toBeInstanceOf(CustomerOptedOutError);
    expect(MockMessagingProvider.getSentHistory()).toHaveLength(0);

    // No ledger row for the suppressed round.
    const ledger = await listMessagesForCase(
      { db },
      { tenantId, caseId: recoveryCase.id },
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe("SENT");

    // Workflow stops cleanly on the stop condition.
    const stopped = await transitionCaseStatus(
      { db },
      {
        tenantId,
        caseId: recoveryCase.id,
        from: ["IN_PROGRESS"],
        to: "STOPPED",
        reason: "OPTED_OUT",
      },
    );
    expect(stopped?.status).toBe("STOPPED");
    const reloaded = await findCaseById({ db }, { tenantId, caseId: recoveryCase.id });
    expect(reloaded?.status).toBe("STOPPED");

    await assertInvariants(tenantId);
  });
});
