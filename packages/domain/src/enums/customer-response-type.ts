export const CUSTOMER_RESPONSE_TYPES = [
  "REPLY",
  "OPT_OUT",
  "PROMISE_TO_PAY",
  "COMPLAINT",
  "OTHER",
] as const;

export type CustomerResponseType = (typeof CUSTOMER_RESPONSE_TYPES)[number];

export const CustomerResponseType = Object.freeze(
  Object.fromEntries(CUSTOMER_RESPONSE_TYPES.map((value) => [value, value])),
) as Readonly<Record<CustomerResponseType, CustomerResponseType>>;
