import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { createHmac, createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app";
import {
  sendCaseMessage,
  CustomerOptedOutError,
  ContactCapExceededError,
  deriveMessageIdempotencyKey,
} from "../modules/messaging";
import {
  MockMessagingProvider,
  NullBus,
} from "@repo/integrations";
import {
  createTenant,
  createCustomer,
  createCase,
  findMessageById,
  findCustomerById,
  listDeliveryEvents,
  createUser,
  createSession,
  type RecoveryCase,
  type Customer,
  type Tenant,
} from "@repo/db";

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

describe("Messaging Adapters & Delivery Ledger Integration Suite", { timeout: 60000 }, () => {
  let app: FastifyInstance;
  let eventBus: NullBus;
  let tenant: Tenant;
  let tenantB: Tenant;
  let viewerCookie: string;
  let adminCookie: string;

  const WA_VERIFY_SECRET = "whatsapp_webhook_verify_secret";
  const EMAIL_WEBHOOK_SECRET = "email_webhook_secret";

  const createTestUserSession = async (
    tenantId: string,
    role: "VIEWER" | "SUPPORT" | "OPERATIONS" | "FINANCE" | "ADMIN",
  ): Promise<string> => {
    const runId = randomUUID().slice(0, 8);
    const user = await createUser(
      { db: app.db },
      {
        tenantId,
        email: `${role.toLowerCase()}_${runId}@example.com`,
        name: `${role} User`,
        passwordHash: "dummy_hash",
        role,
        status: "ACTIVE",
      },
    );

    const token = `tok_${randomUUID()}`;
    const tokenHash = sha256(token);
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);

    await createSession(
      { db: app.db },
      {
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    );

    return `rr_session=${token}; Path=/; HttpOnly`;
  };

  const createTestFixture = async (name: string, email: string, phone: string) => {
    const cust = await createCustomer(
      { db: app.db },
      {
        tenantId: tenant.id,
        name,
        email,
        phone,
        status: "ACTIVE",
        optedOut: false,
      },
    );

    const recoveryCase = await createCase(
      { db: app.db },
      {
        tenantId: tenant.id,
        customerId: cust.id,
        sourceEntityType: "PAYMENT",
        sourceEntityId: randomUUID(),
        riskType: "PAYMENT_FAILURE",
        riskScore: 75,
        amountAtRisk: 1500000n, // $150.00
        currency: "USD",
        status: "IN_PROGRESS",
      },
    );

    return { customer: cust, case: recoveryCase };
  };

  beforeAll(async () => {
    eventBus = new NullBus();

    app = await buildApp({
      eventBus,
      disableRateLimit: true,
    });
    await app.ready();

    // Create Test Tenants
    const runId = randomUUID().slice(0, 8);
    tenant = await createTenant(
      { db: app.db },
      {
        name: `Messaging Test Tenant ${runId}`,
        slug: `msg-test-${runId}`,
      },
    );

    tenantB = await createTenant(
      { db: app.db },
      {
        name: `Messaging Tenant B ${runId}`,
        slug: `msg-tenant-b-${runId}`,
      },
    );

    viewerCookie = await createTestUserSession(tenant.id, "VIEWER");
    adminCookie = await createTestUserSession(tenant.id, "ADMIN");
  });

  beforeEach(() => {
    MockMessagingProvider.clearHistory();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("1. Happy Send & Delivery Lifecycle", () => {
    it("runs complete pipeline: QUEUED -> SENT -> DELIVERED -> READ via webhook fixtures", async () => {
      const fixture = await createTestFixture("Alice Happy", "alice.happy@example.com", "+14155552671");
      const mockProvider = new MockMessagingProvider();

      // 1. Send templated WhatsApp message
      const sendResult = await sendCaseMessage(
        {
          db: app.db,
          repos: app.repos,
          customAdapter: mockProvider,
        },
        {
          tenantId: tenant.id,
          caseId: fixture.case.id,
          customerId: fixture.customer.id,
          channel: "WHATSAPP",
          templateId: "payment_retry_notice",
          variables: {
            customer_name: "Alice Happy",
            amount: "150.00",
            currency: "USD",
            payment_link: "https://pay.example.com/retry/101",
            due_date: "2026-09-05",
          },
          step: 1,
        },
      );

      expect(sendResult.status).toBe("SENT");
      expect(sendResult.providerMessageId).toBeDefined();
      const providerMsgId = sendResult.providerMessageId!;

      // Verify message row in DB
      const messageInDb = await findMessageById({ db: app.db }, {
        tenantId: tenant.id,
        messageId: sendResult.messageId,
      });
      expect(messageInDb).not.toBeNull();
      expect(messageInDb?.status).toBe("SENT");
      expect(messageInDb?.providerMessageId).toBe(providerMsgId);

      // Verify delivery event row (SENT)
      let deliveryEvents = await listDeliveryEvents({ db: app.db }, {
        messageId: sendResult.messageId,
      });
      expect(deliveryEvents.length).toBe(1);
      expect(deliveryEvents[0].status).toBe("SENT");

      const baseTimestampSec = Math.floor(Date.now() / 1000);

      // 2. Deliver WhatsApp DELIVERED status webhook fixture
      const waWebhookPayloadDelivered = {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "WHATSAPP_BUSINESS_ACCOUNT_ID",
            changes: [
              {
                value: {
                  messaging_product: "whatsapp",
                  metadata: { display_phone_number: "15550248142", phone_number_id: "27414141" },
                  statuses: [
                    {
                      id: providerMsgId,
                      status: "delivered",
                      timestamp: String(baseTimestampSec + 10),
                      recipient_id: "14155552671",
                    },
                  ],
                },
                field: "messages",
              },
            ],
          },
        ],
      };

      const rawBodyDelivered = JSON.stringify(waWebhookPayloadDelivered);
      const sigDelivered = `sha256=${createHmac("sha256", WA_VERIFY_SECRET).update(rawBodyDelivered).digest("hex")}`;

      const resDelivered = await app.inject({
        method: "POST",
        url: "/webhooks/whatsapp",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sigDelivered,
        },
        payload: rawBodyDelivered,
      });

      expect(resDelivered.statusCode).toBe(200);

      // Check message transitioned to DELIVERED
      const updatedDelivered = await findMessageById({ db: app.db }, {
        tenantId: tenant.id,
        messageId: sendResult.messageId,
      });
      expect(updatedDelivered?.status).toBe("DELIVERED");

      // 3. Deliver WhatsApp READ status webhook fixture
      const waWebhookPayloadRead = {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "WHATSAPP_BUSINESS_ACCOUNT_ID",
            changes: [
              {
                value: {
                  messaging_product: "whatsapp",
                  metadata: { display_phone_number: "15550248142", phone_number_id: "27414141" },
                  statuses: [
                    {
                      id: providerMsgId,
                      status: "read",
                      timestamp: String(baseTimestampSec + 20),
                      recipient_id: "14155552671",
                    },
                  ],
                },
                field: "messages",
              },
            ],
          },
        ],
      };

      const rawBodyRead = JSON.stringify(waWebhookPayloadRead);
      const sigRead = `sha256=${createHmac("sha256", WA_VERIFY_SECRET).update(rawBodyRead).digest("hex")}`;

      const resRead = await app.inject({
        method: "POST",
        url: "/webhooks/whatsapp",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sigRead,
        },
        payload: rawBodyRead,
      });

      expect(resRead.statusCode).toBe(200);

      const updatedRead = await findMessageById({ db: app.db }, {
        tenantId: tenant.id,
        messageId: sendResult.messageId,
      });
      expect(updatedRead?.status).toBe("READ");

      // Verify all 3 delivery events recorded in timeline
      deliveryEvents = await listDeliveryEvents({ db: app.db }, {
        messageId: sendResult.messageId,
      });
      expect(deliveryEvents.length).toBe(3);
      expect(deliveryEvents.map((e) => e.status)).toEqual(["SENT", "DELIVERED", "READ"]);
    });
  });

  describe("2. Idempotency Key & Anti-Duplication Anchor", () => {
    it("deduplicates identical step sends and calls provider adapter exactly once (spy check)", async () => {
      const fixture = await createTestFixture("Dedup Tester", "dedup.tester@example.com", "+14155552222");
      const mockProvider = new MockMessagingProvider();
      const sendSpy = vi.spyOn(mockProvider, "sendTemplate");

      const input = {
        tenantId: tenant.id,
        caseId: fixture.case.id,
        customerId: fixture.customer.id,
        channel: "WHATSAPP" as const,
        templateId: "payment_retry_notice",
        variables: {
          customer_name: "Dedup Tester",
          amount: "150.00",
          currency: "USD",
          payment_link: "https://pay.example.com/retry/101",
          due_date: "2026-09-05",
        },
        step: 1,
      };

      // First dispatch
      const first = await sendCaseMessage(
        {
          db: app.db,
          repos: app.repos,
          customAdapter: mockProvider,
        },
        input,
      );

      expect(first.status).toBe("SENT");
      expect(first.isDuplicate).toBeUndefined();
      expect(sendSpy).toHaveBeenCalledTimes(1);

      // Second dispatch (identical key)
      const second = await sendCaseMessage(
        {
          db: app.db,
          repos: app.repos,
          customAdapter: mockProvider,
        },
        input,
      );

      expect(second.status).toBe("SENT");
      expect(second.messageId).toBe(first.messageId);
      expect(second.isDuplicate).toBe(true);
      // Spy remains at 1! Provider was not hit a second time.
      expect(sendSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("3. Provider Failure & Resilience", () => {
    it("marks message as FAILED and writes failure delivery event when provider fails", async () => {
      const fixture = await createTestFixture("Fail Tester", "fail.tester@example.com", "+14155553333");
      const mockProvider = new MockMessagingProvider();
      MockMessagingProvider.simulateNextFailures(1);

      const input = {
        tenantId: tenant.id,
        caseId: fixture.case.id,
        customerId: fixture.customer.id,
        channel: "WHATSAPP" as const,
        templateId: "payment_retry_notice",
        variables: {
          customer_name: "Fail Tester",
          amount: "150.00",
          currency: "USD",
          payment_link: "https://pay.example.com/retry/101",
          due_date: "2026-09-05",
        },
        step: 1,
      };

      await expect(
        sendCaseMessage(
          {
            db: app.db,
            repos: app.repos,
            customAdapter: mockProvider,
          },
          input,
        ),
      ).rejects.toThrow();

      // Check DB: message exists with status FAILED
      const key = deriveMessageIdempotencyKey({
        tenantId: tenant.id,
        caseId: fixture.case.id,
        channel: "WHATSAPP",
        templateId: "payment_retry_notice",
        step: 1,
      });

      const messageInDb = await app.repos.findMessageByIdempotencyKey({ db: app.db }, {
        tenantId: tenant.id,
        idempotencyKey: key,
      });

      expect(messageInDb).not.toBeNull();
      expect(messageInDb?.status).toBe("FAILED");
      expect(messageInDb?.finalStatusAt).toBeDefined();

      const events = await listDeliveryEvents({ db: app.db }, { messageId: messageInDb!.id });
      expect(events.some((e) => e.status === "FAILED")).toBe(true);
    });
  });

  describe("4. Webhook Signature Security & Replay Deduplication", () => {
    it("rejects invalid webhook signatures with 401", async () => {
      const payload = {
        object: "whatsapp_business_account",
        entry: [],
      };
      const rawBody = JSON.stringify(payload);

      const res = await app.inject({
        method: "POST",
        url: "/webhooks/whatsapp",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": "sha256=invalid_hash_signature_0000000000000000000000000000000000000000000000000000000000000000",
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(401);
      const json = res.json();
      expect(json.error?.code).toBe("INVALID_SIGNATURE");
    });

    it("verifies Meta webhook subscription challenge on GET /webhooks/whatsapp", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${WA_VERIFY_SECRET}&hub.challenge=test_challenge_12345`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("test_challenge_12345");
    });

    it("accepts valid Email status callbacks and handles delivery status update", async () => {
      const fixture = await createTestFixture("Email Tester", "email.tester@example.com", "+14155554444");

      // First create an email message
      const emailSend = await sendCaseMessage(
        {
          db: app.db,
          repos: app.repos,
          customAdapter: new MockMessagingProvider(),
        },
        {
          tenantId: tenant.id,
          caseId: fixture.case.id,
          customerId: fixture.customer.id,
          channel: "EMAIL",
          templateId: "invoice_reminder",
          variables: {
            customer_name: "Email Tester",
            invoice_number: "INV-999",
            amount_due: "250.00",
            currency: "USD",
            due_date: "2026-09-01",
            payment_url: "https://pay.example.com/inv/999",
          },
          step: 1,
        },
      );

      const emailProviderId = emailSend.providerMessageId!;

      const emailWebhookPayload = {
        type: "email.delivered",
        email_id: emailProviderId,
        created_at: new Date().toISOString(),
      };

      const res = await app.inject({
        method: "POST",
        url: "/webhooks/email",
        headers: {
          "content-type": "application/json",
          "x-webhook-token": EMAIL_WEBHOOK_SECRET,
        },
        payload: emailWebhookPayload,
      });

      expect(res.statusCode).toBe(200);

      const msg = await findMessageById({ db: app.db }, {
        tenantId: tenant.id,
        messageId: emailSend.messageId,
      });
      expect(msg?.status).toBe("DELIVERED");
    });
  });

  describe("5. Inbound STOP Keyword & Customer Opt-Out Automation", () => {
    it("sets customer opted_out = true and blocks subsequent dispatches", async () => {
      const randomDigits = Math.floor(1000000 + Math.random() * 9000000);
      const uniquePhone = `+1415${randomDigits}`;

      const optOutCustomer = await createCustomer(
        { db: app.db },
        {
          tenantId: tenant.id,
          name: "Opt Out Tester",
          email: `optout.${randomDigits}@example.com`,
          phone: uniquePhone,
          status: "ACTIVE",
          optedOut: false,
        },
      );

      expect(optOutCustomer.optedOut).toBe(false);

      // Inbound WhatsApp message with STOP keyword
      const inboundPayload = {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "WHATSAPP_BUSINESS_ACCOUNT_ID",
            changes: [
              {
                value: {
                  messaging_product: "whatsapp",
                  metadata: { display_phone_number: "15550248142", phone_number_id: "27414141" },
                  messages: [
                    {
                      from: uniquePhone,
                      id: `wamid_inbound_stop_${randomDigits}`,
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      text: { body: "STOP" },
                      type: "text",
                    },
                  ],
                },
                field: "messages",
              },
            ],
          },
        ],
      };

      const rawBody = JSON.stringify(inboundPayload);
      const sig = `sha256=${createHmac("sha256", WA_VERIFY_SECRET).update(rawBody).digest("hex")}`;

      const res = await app.inject({
        method: "POST",
        url: "/webhooks/whatsapp",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sig,
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);

      // Verify customer.opted_out = true immediately
      const refreshedCustomer = await findCustomerById({ db: app.db }, {
        tenantId: tenant.id,
        customerId: optOutCustomer.id,
      });
      expect(refreshedCustomer?.optedOut).toBe(true);

      // Verify subsequent message send attempt is rejected
      await expect(
        sendCaseMessage(
          {
            db: app.db,
            repos: app.repos,
            customAdapter: new MockMessagingProvider(),
          },
          {
            tenantId: tenant.id,
            customerId: optOutCustomer.id,
            channel: "WHATSAPP",
            templateId: "payment_retry_notice",
            variables: {
              customer_name: "Opt Out Tester",
              amount: "50.00",
              currency: "USD",
              payment_link: "https://pay.example.com/retry/2",
              due_date: "2026-09-01",
            },
            step: 1,
          },
        ),
      ).rejects.toThrow(CustomerOptedOutError);
    });
  });

  describe("6. Defense-in-Depth Policy Contact Cap Rechecks", () => {
    it("blocks 3rd WhatsApp message in 7 days even if policy layer is bypassed", async () => {
      const fixture = await createTestFixture("Cap WhatsApp Tester", "cap.wa@example.com", "+14155558888");
      const mockProvider = new MockMessagingProvider();

      // Send 1st WhatsApp message
      await sendCaseMessage(
        { db: app.db, repos: app.repos, customAdapter: mockProvider },
        {
          tenantId: tenant.id,
          caseId: fixture.case.id,
          customerId: fixture.customer.id,
          channel: "WHATSAPP",
          templateId: "payment_retry_notice",
          variables: {
            customer_name: "Cap Tester",
            amount: "10.00",
            currency: "USD",
            payment_link: "https://pay.example.com/1",
            due_date: "2026-09-01",
          },
          step: 1,
        },
      );

      // Send 2nd WhatsApp message
      await sendCaseMessage(
        { db: app.db, repos: app.repos, customAdapter: mockProvider },
        {
          tenantId: tenant.id,
          caseId: fixture.case.id,
          customerId: fixture.customer.id,
          channel: "WHATSAPP",
          templateId: "payment_retry_notice",
          variables: {
            customer_name: "Cap Tester",
            amount: "10.00",
            currency: "USD",
            payment_link: "https://pay.example.com/2",
            due_date: "2026-09-01",
          },
          step: 2,
        },
      );

      // 3rd WhatsApp message attempt must be rejected by pipeline cap recheck
      await expect(
        sendCaseMessage(
          { db: app.db, repos: app.repos, customAdapter: mockProvider },
          {
            tenantId: tenant.id,
            caseId: fixture.case.id,
            customerId: fixture.customer.id,
            channel: "WHATSAPP",
            templateId: "payment_retry_notice",
            variables: {
              customer_name: "Cap Tester",
              amount: "10.00",
              currency: "USD",
              payment_link: "https://pay.example.com/3",
              due_date: "2026-09-01",
            },
            step: 3,
          },
        ),
      ).rejects.toThrow(ContactCapExceededError);
    });

    it("blocks 4th Email message in 14 days even if policy layer is bypassed", async () => {
      const fixture = await createTestFixture("Cap Email Tester", "cap.email@example.com", "+14155557777");
      const mockProvider = new MockMessagingProvider();

      for (let step = 1; step <= 3; step++) {
        await sendCaseMessage(
          { db: app.db, repos: app.repos, customAdapter: mockProvider },
          {
            tenantId: tenant.id,
            caseId: fixture.case.id,
            customerId: fixture.customer.id,
            channel: "EMAIL",
            templateId: "invoice_reminder",
            variables: {
              customer_name: "Cap Email Tester",
              invoice_number: `INV-00${step}`,
              amount_due: "10.00",
              currency: "USD",
              due_date: "2026-09-01",
              payment_url: "https://pay.example.com",
            },
            step,
          },
        );
      }

      // 4th Email message in 14d must fail
      await expect(
        sendCaseMessage(
          { db: app.db, repos: app.repos, customAdapter: mockProvider },
          {
            tenantId: tenant.id,
            caseId: fixture.case.id,
            customerId: fixture.customer.id,
            channel: "EMAIL",
            templateId: "invoice_reminder",
            variables: {
              customer_name: "Cap Email Tester",
              invoice_number: "INV-004",
              amount_due: "10.00",
              currency: "USD",
              due_date: "2026-09-01",
              payment_url: "https://pay.example.com",
            },
            step: 4,
          },
        ),
      ).rejects.toThrow(ContactCapExceededError);
    });
  });

  describe("7. Message Read APIs & Tenant Isolation", () => {
    it("GET /messages returns redacted list and respects RBAC", async () => {
      const fixture = await createTestFixture("Read Tester", "read.tester@example.com", "+14155552671");
      const mockProvider = new MockMessagingProvider();

      await sendCaseMessage(
        { db: app.db, repos: app.repos, customAdapter: mockProvider },
        {
          tenantId: tenant.id,
          caseId: fixture.case.id,
          customerId: fixture.customer.id,
          channel: "WHATSAPP",
          templateId: "payment_retry_notice",
          variables: {
            customer_name: "Read Tester",
            amount: "150.00",
            currency: "USD",
            payment_link: "https://pay.example.com/retry/101",
            due_date: "2026-09-05",
          },
          step: 1,
        },
      );

      const res = await app.inject({
        method: "GET",
        url: `/messages?case_id=${fixture.case.id}&channel=WHATSAPP`,
        headers: {
          cookie: viewerCookie,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.items).toBeDefined();
      expect(Array.isArray(data.items)).toBe(true);
      expect(data.items.length).toBeGreaterThan(0);

      // Verify PII is masked
      const item = data.items[0];
      expect(item.to_address_masked).toBeDefined();
      expect(item.to_address_masked).not.toBe("+14155552671"); // Raw phone unmasked not present
      expect(item.to_address_masked).toMatch(/^\+1\*{3}2671$/);
    });

    it("GET /messages/:id returns message with delivery events", async () => {
      const fixture = await createTestFixture("Detail Tester", "detail.tester@example.com", "+14155551111");
      const mockProvider = new MockMessagingProvider();

      const sent = await sendCaseMessage(
        { db: app.db, repos: app.repos, customAdapter: mockProvider },
        {
          tenantId: tenant.id,
          caseId: fixture.case.id,
          customerId: fixture.customer.id,
          channel: "WHATSAPP",
          templateId: "payment_retry_notice",
          variables: {
            customer_name: "Detail Tester",
            amount: "150.00",
            currency: "USD",
            payment_link: "https://pay.example.com/retry/101",
            due_date: "2026-09-05",
          },
          step: 1,
        },
      );

      const res = await app.inject({
        method: "GET",
        url: `/messages/${sent.messageId}`,
        headers: {
          cookie: viewerCookie,
        },
      });

      expect(res.statusCode).toBe(200);
      const msg = res.json();
      expect(msg.id).toBe(sent.messageId);
      expect(msg.to_address_masked).toBeDefined();
      expect(msg.delivery_events).toBeDefined();
      expect(Array.isArray(msg.delivery_events)).toBe(true);
      expect(msg.delivery_events.length).toBeGreaterThan(0);
    });

    it("enforces tenant isolation: Tenant B cannot read Tenant A messages (404)", async () => {
      const fixture = await createTestFixture("Iso Tester", "iso.tester@example.com", "+14155550000");
      const mockProvider = new MockMessagingProvider();

      const sent = await sendCaseMessage(
        { db: app.db, repos: app.repos, customAdapter: mockProvider },
        {
          tenantId: tenant.id,
          caseId: fixture.case.id,
          customerId: fixture.customer.id,
          channel: "WHATSAPP",
          templateId: "payment_retry_notice",
          variables: {
            customer_name: "Iso Tester",
            amount: "150.00",
            currency: "USD",
            payment_link: "https://pay.example.com/retry/101",
            due_date: "2026-09-05",
          },
          step: 1,
        },
      );

      // Create session for Tenant B
      const tenantBCookie = await createTestUserSession(tenantB.id, "ADMIN");

      const res = await app.inject({
        method: "GET",
        url: `/messages/${sent.messageId}`,
        headers: {
          cookie: tenantBCookie,
        },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe("8. PII Leakage Sweep Test", () => {
    it("ensures no raw phone numbers or raw email addresses are leaked in message read responses", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/messages?limit=50`,
        headers: {
          cookie: adminCookie,
        },
      });

      expect(res.statusCode).toBe(200);
      const rawBody = res.body;

      // Sweep assertions
      expect(rawBody).not.toContain("+14155552671");
      expect(rawBody).not.toContain("alice.happy@example.com");
      expect(rawBody).not.toContain("cap.email@example.com");
      expect(rawBody).not.toContain("+14155558888");
    });
  });
});
