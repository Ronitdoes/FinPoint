export const MESSAGE_DIRECTIONS = ["OUTBOUND", "INBOUND"] as const;

export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const MessageDirection = Object.freeze(
  Object.fromEntries(MESSAGE_DIRECTIONS.map((value) => [value, value])),
) as Readonly<Record<MessageDirection, MessageDirection>>;
