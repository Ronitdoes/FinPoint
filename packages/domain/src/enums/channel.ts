export const CHANNELS = ["WHATSAPP", "EMAIL", "SMS"] as const;

export type Channel = (typeof CHANNELS)[number];

export const Channel = Object.freeze(
  Object.fromEntries(CHANNELS.map((value) => [value, value])),
) as Readonly<Record<Channel, Channel>>;
