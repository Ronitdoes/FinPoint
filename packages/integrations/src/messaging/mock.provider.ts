import { randomUUID } from "node:crypto";
import type { MessagingProvider, SendResult, SendTemplateInput } from "./types";
import { assertValidTemplateVariables, renderTemplate } from "./templates/registry";

export interface MockMessagingProviderOptions {
  simulateFailure?: boolean;
  failureErrorCode?: string;
  failureErrorMessage?: string;
  recordInHistory?: boolean;
}

export interface SentMessageRecord {
  input: SendTemplateInput;
  result: SendResult;
  sentAt: Date;
}

/**
 * Mock Messaging Provider for offline tests, local demo, and deterministic verification.
 * Spec 03 §2, Spec 01 §14, s-19.
 */
export class MockMessagingProvider implements MessagingProvider {
  private static sentHistory: SentMessageRecord[] = [];
  private static outcomeOverrides = new Map<string, { shouldFail: boolean; code?: string; message?: string }>();
  private static nextFailureCount = 0;

  private readonly simulateFailure: boolean;
  private readonly failureErrorCode: string;
  private readonly failureErrorMessage: string;

  constructor(options: MockMessagingProviderOptions = {}) {
    this.simulateFailure =
      options.simulateFailure ??
      process.env.SIMULATE_MESSAGE_FAILURE === "true";
    this.failureErrorCode = options.failureErrorCode || "MOCK_MESSAGE_DISPATCH_FAILED";
    this.failureErrorMessage = options.failureErrorMessage || "Simulated message dispatch failure";
  }

  /**
   * Clears the recorded sent messages history and outcome overrides.
   */
  static clearHistory(): void {
    MockMessagingProvider.sentHistory = [];
    MockMessagingProvider.outcomeOverrides.clear();
    MockMessagingProvider.nextFailureCount = 0;
  }

  /**
   * Returns all recorded sent messages.
   */
  static getSentHistory(): SentMessageRecord[] {
    return [...MockMessagingProvider.sentHistory];
  }

  /**
   * Injects a scripted failure for the next N messages.
   */
  static simulateNextFailures(count = 1): void {
    MockMessagingProvider.nextFailureCount = count;
  }

  /**
   * Overrides outcome for a specific idempotency key.
   */
  static setOutcomeOverride(
    idempotencyKey: string,
    override: { shouldFail: boolean; code?: string; message?: string },
  ): void {
    MockMessagingProvider.outcomeOverrides.set(idempotencyKey, override);
  }

  /**
   * Dispatches a templated message in mock mode.
   */
  async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
    // 1. Validate variables against registry
    assertValidTemplateVariables(input.templateId, input.variables);

    // 2. Check for explicit overrides / simulation flags
    const override = MockMessagingProvider.outcomeOverrides.get(input.idempotencyKey);
    const shouldFail =
      override?.shouldFail ||
      this.simulateFailure ||
      MockMessagingProvider.nextFailureCount > 0;

    if (MockMessagingProvider.nextFailureCount > 0) {
      MockMessagingProvider.nextFailureCount--;
    }

    if (shouldFail) {
      const err = new Error(
        override?.message || this.failureErrorMessage,
      ) as any;
      err.code = override?.code || this.failureErrorCode;
      throw err;
    }

    // 3. Render template to ensure rendering works cleanly
    renderTemplate(
      input.templateId,
      input.channel,
      input.language || "en",
      input.variables,
    );

    const prefix = input.channel === "WHATSAPP" ? "wamid_mock" : "email_mock";
    const providerMessageId = `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    const feeMinor = input.channel === "WHATSAPP" ? 50n : 5n; // 50 paise / 5 paise
    const feeCurrency = "INR";

    const result: SendResult = {
      providerMessageId,
      acceptedAt: new Date(),
      status: "SENT",
      fee: {
        amount: feeMinor,
        currency: feeCurrency,
      },
      rawResponse: {
        mock: true,
        channel: input.channel,
        templateId: input.templateId,
        toAddress: input.toAddress,
        idempotencyKey: input.idempotencyKey,
      },
    };

    MockMessagingProvider.sentHistory.push({
      input,
      result,
      sentAt: new Date(),
    });

    return result;
  }
}
