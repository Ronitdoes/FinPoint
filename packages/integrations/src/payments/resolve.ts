import type { Provider } from "@repo/domain";
import type { PaymentsConfig, DemoConfig } from "@repo/config";
import type { PaymentProvider } from "./types";
import { StripeAdapter } from "./stripe.adapter";
import { RazorpayAdapter } from "./razorpay.adapter";
import { MockPaymentProvider } from "./mock.provider";

export interface ResolvePaymentProviderOptions {
  provider?: Provider | string;
  paymentsConfig?: Partial<PaymentsConfig> | null;
  demoConfig?: Partial<DemoConfig> | null;
  customAdapter?: PaymentProvider;
}

/**
 * Resolves the appropriate PaymentProvider adapter (Stripe, Razorpay, or Mock)
 * based on the requested provider and system configuration (Spec 01 §14, Spec 18 §resolve.ts).
 */
export function providerFor(
  tenantConfig?: {
    payments?: Partial<PaymentsConfig>;
    demo?: Partial<DemoConfig>;
  } | null,
  kind?: Provider | string,
): PaymentProvider {
  return resolvePaymentProvider({
    provider: kind,
    paymentsConfig: tenantConfig?.payments,
    demoConfig: tenantConfig?.demo,
  });
}

/**
 * Main resolution function for payment adapters.
 */
export function resolvePaymentProvider(
  options: ResolvePaymentProviderOptions = {},
): PaymentProvider {
  if (options.customAdapter) {
    return options.customAdapter;
  }

  const isMockMode =
    options.demoConfig?.mockProviders === true ||
    options.provider === "MOCK" ||
    (!options.paymentsConfig?.stripeSecretKey &&
      !options.paymentsConfig?.razorpayKeyId &&
      options.demoConfig?.mockProviders !== false);

  if (isMockMode) {
    return new MockPaymentProvider({
      simulateTimeout: options.demoConfig?.simulatePaymentTimeout ?? false,
    });
  }

  const normalizedProvider = (options.provider || "STRIPE").toUpperCase();

  if (normalizedProvider === "STRIPE") {
    return new StripeAdapter({
      secretKey: options.paymentsConfig?.stripeSecretKey,
    });
  }

  if (normalizedProvider === "RAZORPAY") {
    return new RazorpayAdapter({
      keyId: options.paymentsConfig?.razorpayKeyId,
      keySecret: options.paymentsConfig?.razorpayKeySecret,
    });
  }

  return new MockPaymentProvider({
    simulateTimeout: options.demoConfig?.simulatePaymentTimeout ?? false,
  });
}
