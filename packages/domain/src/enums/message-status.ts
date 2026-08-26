export const MESSAGE_STATUSES = [
  "QUEUED",
  "SENT",
  "DELIVERED",
  "READ",
  "FAILED",
  "BOUNCED",
  "REJECTED",
] as const;

export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const MessageStatus = Object.freeze(
  Object.fromEntries(MESSAGE_STATUSES.map((value) => [value, value])),
) as Readonly<Record<MessageStatus, MessageStatus>>;
