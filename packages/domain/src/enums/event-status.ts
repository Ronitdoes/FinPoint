export const EVENT_STATUSES = [
  "RECEIVED",
  "PROCESSING",
  "PROCESSED",
  "FAILED",
] as const;

export type EventStatus = (typeof EVENT_STATUSES)[number];

export const EventStatus = Object.freeze(
  Object.fromEntries(EVENT_STATUSES.map((value) => [value, value])),
) as Readonly<Record<EventStatus, EventStatus>>;
