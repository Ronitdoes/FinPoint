import type {
  PaymentProvider,
  RetryPaymentInput,
  RetryPaymentResult,
  CreatePaymentLinkInput,
  PaymentLinkResult,
  PaymentStatusResult,
  ProviderFee,
  RetryPaymentStatus,
  InternalDeclineCode,
} from "./types";

export interface MockOutcomeOverride {
  status: RetryPaymentStatus;
  failureCode?: InternalDeclineCode | string;
  failureMessage?: string;
  feeAmount?: bigint;
  feeCurrency?: string;
  delayMs?: number;
}

export interface MockProviderOptions {
  simulateTimeout?: boolean;
  defaultSuccessOnAttempt?: number; // e.g. 2 means attempt 1 fails, attempt 2 succeeds
}

/**
 * Deterministic Mock Payment Provider (Spec 03 §2, §9, Spec 18 §Mock provider scripting).
 * Drives test suites, local sandboxes, and fault-injection scenarios without real money.
 */
export class MockPaymentProvider implements PaymentProvider {
  private static readonly overrides = new Map<string, MockOutcomeOverride>();
  private readonly simulateTimeout: boolean;
  private readonly defaultSuccessOnAttempt: number;

  constructor(options: MockProviderOptions = {}) {
    this.simulateTimeout = options.simulateTimeout ?? false;
    this.defaultSuccessOnAttempt = options.defaultSuccessOnAttempt ?? 2;
  }

  /**
   * Set explicit outcome override for a specific idempotency key or provider payment ID.
   */
  static setOutcomeOverride(key: string, override: MockOutcomeOverride): void {
    MockPaymentProvider.overrides.set(key, override);
  }

  /**
   * Get configured outcome override.
   */
  static getOutcomeOverride(key: string): MockOutcomeOverride | undefined {
    return MockPaymentProvider.overrides.get(key);
  }

  /**
   * Clear all outcome overrides.
   */
  static clearOverrides(): void {
    MockPaymentProvider.overrides.clear();
  }

  /**
   * Executes deterministic mock retry payment.
   */
  async retryPayment(input: RetryPaymentInput): Promise<RetryPaymentResult> {
    // 1. Check for failure injection timeout switch
    if (this.simulateTimeout) {
      // Simulate hang past timeout budget
      await new Promise((resolve) => setTimeout(resolve, 20000));
      return {
        status: "UNKNOWN",
        providerReference: `mock_timeout_${input.paymentId}`,
        failureMessage: "Payment request timed out (simulated via SIMULATE_PAYMENT_TIMEOUT)",
      };
    }

    // 2. Check explicit override table (s-29 / demo / test endpoint)
    const override =
      MockPaymentProvider.overrides.get(input.idempotencyKey) ??
      (input.providerPaymentId ? MockPaymentProvider.overrides.get(input.providerPaymentId) : undefined);

    if (override) {
      if (override.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, override.delayMs));
      }

      if (override.status === "SUCCEEDED") {
        const fee = this.calculateMockFee(input.amount, input.currency, override);
        return {
          status: "SUCCEEDED",
          providerReference: `mock_tx_${Math.random().toString(36).substring(2, 10)}`,
          fee,
          rawResponse: { mock: true, overridden: true, attempt: input.attemptNumber },
        };
      }

      if (override.status === "FAILED") {
        return {
          status: "FAILED",
          providerReference: `mock_tx_${Math.random().toString(36).substring(2, 10)}`,
          failureCode: override.failureCode || "insufficient_funds",
          rawFailureCode: override.failureCode || "insufficient_funds",
          failureMessage: override.failureMessage || "Payment declined in mock mode",
          rawResponse: { mock: true, overridden: true, attempt: input.attemptNumber },
        };
      }

      return {
        status: override.status,
        providerReference: `mock_tx_${Math.random().toString(36).substring(2, 10)}`,
        failureMessage: override.failureMessage,
        rawResponse: { mock: true, overridden: true, attempt: input.attemptNumber },
      };
    }

    // 3. Default scripting rule (Spec 18):
    // Fail first attempt with insufficient_funds; succeed subsequent attempts
    const isSuccess = input.attemptNumber >= this.defaultSuccessOnAttempt;

    if (isSuccess) {
      const fee = this.calculateMockFee(input.amount, input.currency);
      return {
        status: "SUCCEEDED",
        providerReference: `mock_tx_${input.paymentId.substring(0, 8)}_${input.attemptNumber}`,
        fee,
        rawResponse: {
          mock: true,
          status: "succeeded",
          attempt: input.attemptNumber,
        },
      };
    }

    return {
      status: "FAILED",
      providerReference: `mock_tx_${input.paymentId.substring(0, 8)}_${input.attemptNumber}`,
      failureCode: "insufficient_funds",
      rawFailureCode: "insufficient_funds",
      failureMessage: "Card was declined: Insufficient funds (scripted mock first attempt)",
      rawResponse: {
        mock: true,
        status: "failed",
        decline_code: "insufficient_funds",
        attempt: input.attemptNumber,
      },
    };
  }

  /**
   * Creates a mock Payment Link.
   */
  async createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLinkResult> {
    const linkId = `plink_mock_${Math.random().toString(36).substring(2, 10)}`;
    const expiresAt = input.expiresInMinutes
      ? new Date(Date.now() + input.expiresInMinutes * 60 * 1000)
      : new Date(Date.now() + 24 * 60 * 60 * 1000);

    return {
      paymentLinkId: linkId,
      url: `https://pay.mock-recovery.internal/l/${linkId}`,
      status: "ACTIVE",
      expiresAt,
      rawResponse: {
        mock: true,
        amount: input.amount.toString(),
        currency: input.currency,
        idempotencyKey: input.idempotencyKey,
      },
    };
  }

  /**
   * Queries mock status for a payment ID.
   */
  async getPaymentStatus(id: string): Promise<PaymentStatusResult> {
    const override = MockPaymentProvider.overrides.get(id);

    if (override) {
      if (override.status === "SUCCEEDED") {
        return {
          id,
          status: "SUCCEEDED",
          providerReference: `mock_ref_${id}`,
          fee: {
            amount: override.feeAmount ?? 250n,
            // getPaymentStatus has no currency context; default to INR (repo primary)
            // with per-override feeCurrency threading where provided.
            currency: override.feeCurrency ?? "INR",
          },
          paidAt: new Date(),
          rawResponse: { mock: true, overridden: true },
        };
      }
      if (override.status === "FAILED") {
        return {
          id,
          status: "FAILED",
          providerReference: `mock_ref_${id}`,
          failureCode: override.failureCode || "insufficient_funds",
          failureMessage: override.failureMessage || "Payment declined",
          rawResponse: { mock: true, overridden: true },
        };
      }
      return {
        id,
        status: override.status as any,
        providerReference: `mock_ref_${id}`,
        rawResponse: { mock: true, overridden: true },
      };
    }

    // Default mock response: SUCCEEDED (INR default; getPaymentStatus carries
    // no currency context — callers needing USD set a feeCurrency override).
    return {
      id,
      status: "SUCCEEDED",
      providerReference: `mock_ref_${id}`,
      fee: {
        amount: 250n,
        currency: "INR",
      },
      paidAt: new Date(),
      rawResponse: { mock: true },
    };
  }

  private calculateMockFee(
    amount: bigint,
    currency: string,
    override?: MockOutcomeOverride,
  ): ProviderFee {
    if (override?.feeAmount !== undefined) {
      return {
        amount: override.feeAmount,
        currency: (override.feeCurrency || currency).toUpperCase(),
      };
    }

    // 2% + 30 cents/paise default calculation
    const calculatedFee = (amount * 20n) / 1000n + 30n;
    return {
      amount: calculatedFee > 0n ? calculatedFee : 30n,
      currency: currency.toUpperCase(),
    };
  }
}
