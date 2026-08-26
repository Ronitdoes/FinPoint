export const EVENT_SOURCES = ["STRIPE", "RAZORPAY", "INTERNAL"] as const;

export type EventSource = (typeof EVENT_SOURCES)[number];

export const EventSource = Object.freeze(
  Object.fromEntries(EVENT_SOURCES.map((value) => [value, value])),
) as Readonly<Record<EventSource, EventSource>>;
