export const MESSAGING_PROVIDERS = [
  "WHATSAPP_CLOUD",
  "SMTP_EMAIL",
  "MOCK",
] as const;

export type MessagingProvider = (typeof MESSAGING_PROVIDERS)[number];

export const MessagingProvider = Object.freeze(
  Object.fromEntries(MESSAGING_PROVIDERS.map((value) => [value, value])),
) as Readonly<Record<MessagingProvider, MessagingProvider>>;
