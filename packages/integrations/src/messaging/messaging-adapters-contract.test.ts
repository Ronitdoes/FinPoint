import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MockMessagingProvider,
  WhatsAppAdapter,
  WhatsAppDeliveryError,
  EmailAdapter,
  EmailDeliveryError,
  resolveMessagingProvider,
  messagingProviderFor,
  getTemplate,
  listTemplates,
  validateTemplateVariables,
  assertValidTemplateVariables,
  renderTemplate,
  InvalidTemplateVariablesError,
  TEMPLATE_REGISTRY,
  type SendTemplateInput,
} from "./index";

describe("Messaging Provider Adapters Contract Suite", () => {
  const sampleWhatsAppInput: SendTemplateInput = {
    tenantId: "11111111-1111-1111-1111-111111111111",
    caseId: "22222222-2222-2222-2222-222222222222",
    customerId: "33333333-3333-3333-3333-333333333333",
    channel: "WHATSAPP",
    templateId: "payment_retry_notice",
    variables: {
      customer_name: "Alice Smith",
      amount: "149.00",
      currency: "USD",
      payment_link: "https://pay.example.com/retry/123",
      due_date: "2026-09-01",
    },
    toAddress: "+14155552671",
    idempotencyKey: "11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222:WHATSAPP:payment_retry_notice:1",
    language: "en",
  };

  const sampleEmailInput: SendTemplateInput = {
    tenantId: "11111111-1111-1111-1111-111111111111",
    caseId: "22222222-2222-2222-2222-222222222222",
    customerId: "33333333-3333-3333-3333-333333333333",
    channel: "EMAIL",
    templateId: "invoice_reminder",
    variables: {
      customer_name: "Bob Jones",
      invoice_number: "INV-2026-009",
      amount_due: "500.00",
      currency: "USD",
      due_date: "2026-08-30",
      payment_url: "https://pay.example.com/inv/9",
    },
    toAddress: "bob@example.com",
    idempotencyKey: "11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222:EMAIL:invoice_reminder:1",
    language: "en",
  };

  beforeEach(() => {
    MockMessagingProvider.clearHistory();
  });

  describe("Template Registry & Variable Allowlist Enforcement", () => {
    it("contains all 4 required domain templates", () => {
      expect(TEMPLATE_REGISTRY.payment_retry_notice).toBeDefined();
      expect(TEMPLATE_REGISTRY.cart_reminder).toBeDefined();
      expect(TEMPLATE_REGISTRY.invoice_reminder).toBeDefined();
      expect(TEMPLATE_REGISTRY.ptp_confirmation).toBeDefined();

      const templates = listTemplates();
      expect(templates.length).toBeGreaterThanOrEqual(4);
    });

    it("validates variables against declared allowlist successfully", () => {
      const result = validateTemplateVariables("payment_retry_notice", sampleWhatsAppInput.variables);
      expect(result.valid).toBe(true);
      expect(result.missingVariables).toEqual([]);
      expect(result.unexpectedVariables).toEqual([]);
    });

    it("rejects missing required variables", () => {
      const invalidVars = {
        customer_name: "Alice",
        // missing amount, currency, payment_link, due_date
      };
      const result = validateTemplateVariables("payment_retry_notice", invalidVars);
      expect(result.valid).toBe(false);
      expect(result.missingVariables).toContain("amount");
      expect(result.missingVariables).toContain("currency");
    });

    it("rejects unexpected variables not declared in allowlist (Spec 19 §Variable allowlist)", () => {
      const extraVars = {
        ...sampleWhatsAppInput.variables,
        extra_discount: "20%",
        freeform_message: "Here is your refund",
      };
      const result = validateTemplateVariables("payment_retry_notice", extraVars);
      expect(result.valid).toBe(false);
      expect(result.unexpectedVariables).toContain("extra_discount");
      expect(result.unexpectedVariables).toContain("freeform_message");

      expect(() => {
        assertValidTemplateVariables("payment_retry_notice", extraVars);
      }).toThrow(InvalidTemplateVariablesError);
    });

    it("renders every registered template across languages (en, es, hi)", () => {
      const languages = ["en", "es", "hi"];

      // 1. payment_retry_notice
      for (const lang of languages) {
        const renderedWa = renderTemplate("payment_retry_notice", "WHATSAPP", lang, sampleWhatsAppInput.variables);
        expect(renderedWa.body).toContain("Alice Smith");
        expect(renderedWa.body).toContain("149.00");

        const renderedEmail = renderTemplate("payment_retry_notice", "EMAIL", lang, sampleWhatsAppInput.variables);
        expect(renderedEmail.subject).toBeDefined();
        expect(renderedEmail.body).toContain("Alice Smith");
      }

      // 2. cart_reminder
      const cartVars = {
        customer_name: "Charlie",
        item_count: 3,
        total_amount: "89.99",
        currency: "USD",
        checkout_url: "https://shop.example.com/cart",
        discount_code: "SAVE10",
      };
      for (const lang of languages) {
        const rendered = renderTemplate("cart_reminder", "EMAIL", lang, cartVars);
        expect(rendered.body).toContain("Charlie");
        expect(rendered.body).toContain("SAVE10");
      }

      // 3. invoice_reminder
      for (const lang of languages) {
        const rendered = renderTemplate("invoice_reminder", "EMAIL", lang, sampleEmailInput.variables);
        expect(rendered.body).toContain("INV-2026-009");
      }

      // 4. ptp_confirmation
      const ptpVars = {
        customer_name: "Diana",
        promised_amount: "250.00",
        currency: "USD",
        promised_date: "2026-09-05",
        payment_url: "https://pay.example.com/ptp/1",
      };
      for (const lang of languages) {
        const rendered = renderTemplate("ptp_confirmation", "WHATSAPP", lang, ptpVars);
        expect(rendered.body).toContain("Diana");
        expect(rendered.body).toContain("2026-09-05");
      }
    });
  });

  describe("MockMessagingProvider", () => {
    it("dispatches successfully and records history", async () => {
      const provider = new MockMessagingProvider();
      const result = await provider.sendTemplate(sampleWhatsAppInput);

      expect(result.status).toBe("SENT");
      expect(result.providerMessageId).toMatch(/^wamid_mock_/);
      expect(result.fee).toBeDefined();
      expect(result.fee?.amount).toBe(50n);

      const history = MockMessagingProvider.getSentHistory();
      expect(history.length).toBe(1);
      expect(history[0]?.input.idempotencyKey).toBe(sampleWhatsAppInput.idempotencyKey);
    });

    it("honors simulateFailure option and SIMULATE_MESSAGE_FAILURE injection", async () => {
      const provider = new MockMessagingProvider({ simulateFailure: true });

      await expect(provider.sendTemplate(sampleWhatsAppInput)).rejects.toThrow(
        "Simulated message dispatch failure",
      );
    });

    it("honors simulateNextFailures scripted count", async () => {
      const provider = new MockMessagingProvider();
      MockMessagingProvider.simulateNextFailures(1);

      await expect(provider.sendTemplate(sampleWhatsAppInput)).rejects.toThrow();

      // Subsequent dispatch succeeds
      const result = await provider.sendTemplate(sampleWhatsAppInput);
      expect(result.status).toBe("SENT");
    });

    it("honors outcome overrides by idempotencyKey", async () => {
      const provider = new MockMessagingProvider();
      MockMessagingProvider.setOutcomeOverride(sampleWhatsAppInput.idempotencyKey, {
        shouldFail: true,
        code: "RATE_LIMIT_EXCEEDED",
        message: "Simulated Meta rate limit",
      });

      await expect(provider.sendTemplate(sampleWhatsAppInput)).rejects.toThrow(
        "Simulated Meta rate limit",
      );
    });
  });

  describe("WhatsAppAdapter", () => {
    it("dispatches template payload to Meta Graph API endpoint with auth header", async () => {
      let capturedUrl = "";
      let capturedHeaders: Record<string, string> = {};
      let capturedBody: any = null;

      const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedHeaders = (init?.headers as Record<string, string>) || {};
        capturedBody = JSON.parse(init?.body as string);

        return {
          ok: true,
          status: 200,
          json: async () => ({
            messaging_product: "whatsapp",
            contacts: [{ input: "14155552671", wa_id: "14155552671" }],
            messages: [{ id: "wamid.HBgLMTQxNTU1NTI2NzEVAgARGBI2" }],
          }),
        };
      });

      const adapter = new WhatsAppAdapter({
        apiKey: "test_wa_token_123",
        phoneNumberId: "phone_123456",
        fetchFn: mockFetch as any,
      });

      const result = await adapter.sendTemplate(sampleWhatsAppInput);

      expect(capturedUrl).toContain("/phone_123456/messages");
      expect(capturedHeaders["Authorization"]).toBe("Bearer test_wa_token_123");
      expect(capturedBody.messaging_product).toBe("whatsapp");
      expect(capturedBody.to).toBe("14155552671");
      expect(capturedBody.template.name).toBe("payment_retry_notice");
      expect(result.status).toBe("SENT");
      expect(result.providerMessageId).toBe("wamid.HBgLMTQxNTU1NTI2NzEVAgARGBI2");
    });

    it("retries on 500 network errors up to 2 times", async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 2) {
          return {
            ok: false,
            status: 500,
            text: async () => "Internal Meta Server Error",
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            messaging_product: "whatsapp",
            messages: [{ id: "wamid.retry_success_123" }],
          }),
        };
      });

      const adapter = new WhatsAppAdapter({
        apiKey: "test_wa_token",
        phoneNumberId: "phone_123456",
        fetchFn: mockFetch as any,
      });

      const result = await adapter.sendTemplate(sampleWhatsAppInput);
      expect(callCount).toBe(2);
      expect(result.providerMessageId).toBe("wamid.retry_success_123");
    });

    it("throws WhatsAppDeliveryError on 400 client error without retry", async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        return {
          ok: false,
          status: 400,
          text: async () =>
            JSON.stringify({
              error: {
                message: "(#100) Param template['name'] is not valid",
                type: "OAuthException",
                code: 100,
              },
            }),
        };
      });

      const adapter = new WhatsAppAdapter({
        apiKey: "test_wa_token",
        phoneNumberId: "phone_123456",
        fetchFn: mockFetch as any,
      });

      await expect(adapter.sendTemplate(sampleWhatsAppInput)).rejects.toThrow(WhatsAppDeliveryError);
      expect(callCount).toBe(1);
    });
  });

  describe("EmailAdapter", () => {
    it("dispatches email payload with rendered HTML and custom headers", async () => {
      let capturedBody: any = null;
      let capturedHeaders: Record<string, string> = {};

      const mockFetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        capturedHeaders = (init?.headers as Record<string, string>) || {};
        capturedBody = JSON.parse(init?.body as string);

        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "email_resend_98765",
            from: "recovery@example.com",
            to: ["bob@example.com"],
          }),
        };
      });

      const adapter = new EmailAdapter({
        apiKey: "test_email_api_key",
        fromEmail: "recovery@example.com",
        fetchFn: mockFetch as any,
      });

      const result = await adapter.sendTemplate(sampleEmailInput);

      expect(capturedHeaders["Authorization"]).toBe("Bearer test_email_api_key");
      expect(capturedBody.from).toBe("recovery@example.com");
      expect(capturedBody.to).toEqual(["bob@example.com"]);
      expect(capturedBody.subject).toContain("INV-2026-009");
      expect(capturedBody.html).toContain("INV-2026-009");
      expect(result.status).toBe("SENT");
      expect(result.providerMessageId).toBe("email_resend_98765");
    });
  });

  describe("Resolver", () => {
    it("returns MockMessagingProvider when mockProviders is true or provider is MOCK", () => {
      const adapter = resolveMessagingProvider({
        providerKind: "MOCK",
        demoConfig: { mockProviders: true, simulateMessageFailure: false, simulatePaymentTimeout: false, simulateLlmFailure: false, simulateDuplicateWebhook: false },
      });
      expect(adapter).toBeInstanceOf(MockMessagingProvider);
    });

    it("returns WhatsAppAdapter when channel is WHATSAPP and credentials exist", () => {
      const adapter = resolveMessagingProvider({
        channel: "WHATSAPP",
        messagingConfig: { whatsappApiKey: "wa_key", whatsappPhoneNumberId: "phone_id", emailApiKey: null, emailFrom: null, whatsappVerifySecret: null, emailWebhookSecret: null },
        demoConfig: { mockProviders: false, simulateMessageFailure: false, simulatePaymentTimeout: false, simulateLlmFailure: false, simulateDuplicateWebhook: false },
      });
      expect(adapter).toBeInstanceOf(WhatsAppAdapter);
    });

    it("returns EmailAdapter when channel is EMAIL and credentials exist", () => {
      const adapter = resolveMessagingProvider({
        channel: "EMAIL",
        messagingConfig: { emailApiKey: "email_key", emailFrom: "test@domain.com", whatsappApiKey: null, whatsappPhoneNumberId: null, whatsappVerifySecret: null, emailWebhookSecret: null },
        demoConfig: { mockProviders: false, simulateMessageFailure: false, simulatePaymentTimeout: false, simulateLlmFailure: false, simulateDuplicateWebhook: false },
      });
      expect(adapter).toBeInstanceOf(EmailAdapter);
    });
  });
});
