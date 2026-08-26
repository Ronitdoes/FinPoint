import { describe, expect, it } from "vitest";

import {
  HIGH_VALUE_APPROVAL_MINOR,
  MAX_AUTO_DISCOUNT_MINOR,
  MAX_EMAIL_PER_14_DAYS,
  MAX_PAYMENT_RETRIES,
  MAX_WHATSAPP_PER_7_DAYS,
} from "./limits";

describe("policy limits (spec 03 §6)", () => {
  it("equals the MVP values exactly", () => {
    expect(MAX_PAYMENT_RETRIES).toBe(3);
    expect(MAX_WHATSAPP_PER_7_DAYS).toBe(2);
    expect(MAX_EMAIL_PER_14_DAYS).toBe(3);
    expect(MAX_AUTO_DISCOUNT_MINOR).toBe(500_000);
    expect(HIGH_VALUE_APPROVAL_MINOR).toBe(10_000_000);
  });

  it("keeps money limits as integer minor units", () => {
    expect(Number.isInteger(MAX_AUTO_DISCOUNT_MINOR)).toBe(true);
    expect(Number.isInteger(HIGH_VALUE_APPROVAL_MINOR)).toBe(true);
  });
});
