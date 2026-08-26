export const PROVIDERS = ["STRIPE", "RAZORPAY", "MOCK"] as const;

export type Provider = (typeof PROVIDERS)[number];

export const Provider = Object.freeze(
  Object.fromEntries(PROVIDERS.map((value) => [value, value])),
) as Readonly<Record<Provider, Provider>>;
