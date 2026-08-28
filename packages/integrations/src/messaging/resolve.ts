import type { Channel, MessagingProvider as ProviderKind } from "@repo/domain";
import type { MessagingConfig, DemoConfig } from "@repo/config";
import type { MessagingProvider } from "./types";
import { WhatsAppAdapter } from "./whatsapp.adapter";
import { EmailAdapter } from "./email.adapter";
import { MockMessagingProvider } from "./mock.provider";

export interface ResolveMessagingProviderOptions {
  channel?: Channel;
  providerKind?: ProviderKind | string;
  messagingConfig?: Partial<MessagingConfig> | null;
  demoConfig?: Partial<DemoConfig> | null;
  customAdapter?: MessagingProvider;
}

/**
 * Resolves the appropriate MessagingProvider adapter (WhatsApp, Email, or Mock)
 * based on channel, configuration, and environment (Spec 01 §14, Spec 03 §2, s-19).
 */
export function messagingProviderFor(
  tenantConfig?: {
    messaging?: Partial<MessagingConfig>;
    demo?: Partial<DemoConfig>;
  } | null,
  channel?: Channel,
): MessagingProvider {
  return resolveMessagingProvider({
    channel,
    messagingConfig: tenantConfig?.messaging,
    demoConfig: tenantConfig?.demo,
  });
}

/**
 * Main resolution function for messaging adapters.
 */
export function resolveMessagingProvider(
  options: ResolveMessagingProviderOptions = {},
): MessagingProvider {
  if (options.customAdapter) {
    return options.customAdapter;
  }

  const isMockMode =
    options.demoConfig?.mockProviders === true ||
    options.providerKind === "MOCK" ||
    (!options.messagingConfig?.whatsappApiKey &&
      !options.messagingConfig?.emailApiKey &&
      options.demoConfig?.mockProviders !== false);

  if (isMockMode) {
    return new MockMessagingProvider({
      simulateFailure: options.demoConfig?.simulateMessageFailure ?? false,
    });
  }

  const channel = options.channel || "WHATSAPP";

  if (channel === "WHATSAPP") {
    if (options.messagingConfig?.whatsappApiKey && options.messagingConfig?.whatsappPhoneNumberId) {
      return new WhatsAppAdapter({
        apiKey: options.messagingConfig.whatsappApiKey,
        phoneNumberId: options.messagingConfig.whatsappPhoneNumberId,
      });
    }
    return new MockMessagingProvider({
      simulateFailure: options.demoConfig?.simulateMessageFailure ?? false,
    });
  }

  if (channel === "EMAIL") {
    if (options.messagingConfig?.emailApiKey) {
      return new EmailAdapter({
        apiKey: options.messagingConfig.emailApiKey,
        fromEmail: options.messagingConfig.emailFrom,
      });
    }
    return new MockMessagingProvider({
      simulateFailure: options.demoConfig?.simulateMessageFailure ?? false,
    });
  }

  return new MockMessagingProvider({
    simulateFailure: options.demoConfig?.simulateMessageFailure ?? false,
  });
}
