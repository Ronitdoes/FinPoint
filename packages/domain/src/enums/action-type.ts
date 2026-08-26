export const ACTION_TYPES = [
  "RETRY_PAYMENT",
  "CREATE_PAYMENT_LINK",
  "SEND_EMAIL",
  "SEND_WHATSAPP",
  "SEND_SMS",
  "OFFER_INCENTIVE",
  "REQUEST_PAYMENT_METHOD_UPDATE",
  "CREATE_PROMISE_TO_PAY",
  "CREATE_HUMAN_TASK",
  "PAUSE_CASE",
  "STOP_CASE",
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

export const ActionType = Object.freeze(
  Object.fromEntries(ACTION_TYPES.map((value) => [value, value])),
) as Readonly<Record<ActionType, ActionType>>;

export function isActionType(value: unknown): value is ActionType {
  return (
    typeof value === "string" &&
    (ACTION_TYPES as readonly string[]).includes(value)
  );
}
