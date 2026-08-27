import { describe, it, expect } from "vitest";
import {
  CUSTOMER_CONTEXT_ALLOWLIST,
  maskEmail,
  maskPhone,
  projectAllowlist,
} from "./allowlist";
import {
  CustomerProfileContextSchema,
  CustomerContextSchema,
} from "./types";

describe("Step 13: Customer Context Allowlist & Masking", () => {
  describe("maskEmail", () => {
    it("masks standard email addresses", () => {
      expect(maskEmail("john.doe@example.com")).toBe("j***@e***.com");
      expect(maskEmail("alice@domain.co.uk")).toBe("a***@d***.co.uk");
      expect(maskEmail("test.user+tag@company.io")).toBe("t***@c***.io");
    });

    it("handles short or edge-case emails", () => {
      expect(maskEmail("a@b.com")).toBe("a***@b***.com");
      expect(maskEmail("x@y.z")).toBe("x***@y***.z");
    });

    it("returns null for invalid or nullish emails", () => {
      expect(maskEmail(null)).toBeNull();
      expect(maskEmail(undefined)).toBeNull();
      expect(maskEmail("")).toBeNull();
      expect(maskEmail("not-an-email")).toBeNull();
    });
  });

  describe("maskPhone", () => {
    it("masks phone numbers retaining dial prefix and suffix digits", () => {
      expect(maskPhone("+14155552671")).toBe("+1***2671");
      expect(maskPhone("+919876543210")).toBe("+91***3210");
      expect(maskPhone("1234567890")).toBe("1***7890");
    });

    it("returns null or masked for nullish / short inputs", () => {
      expect(maskPhone(null)).toBeNull();
      expect(maskPhone(undefined)).toBeNull();
      expect(maskPhone("")).toBeNull();
      expect(maskPhone("123")).toBe("***");
    });
  });

  describe("projectAllowlist", () => {
    it("picks only approved keys and ignores extra database fields", () => {
      const dbRow = {
        id: "a0000000-0000-0000-0000-000000000001",
        name: "Alice",
        status: "ACTIVE",
        lifetime_value_minor: 1000,
        tenure_days: 30,
        opted_out: false,
        email_masked: "a***@e***.com",
        phone_masked: "+1***2345",
        // Extra sensitive database fields that MUST NOT leak
        raw_credit_card_pan: "4111111111111111",
        stripe_customer_secret: "cus_secret_12345",
        internal_billing_notes: "Very angry customer, offered 50% discount",
      };

      const projected = projectAllowlist(dbRow, CUSTOMER_CONTEXT_ALLOWLIST.customer);

      expect(projected).toEqual({
        id: "a0000000-0000-0000-0000-000000000001",
        name: "Alice",
        status: "ACTIVE",
        lifetime_value_minor: 1000,
        tenure_days: 30,
        opted_out: false,
        email_masked: "a***@e***.com",
        phone_masked: "+1***2345",
      });

      expect((projected as any).raw_credit_card_pan).toBeUndefined();
      expect((projected as any).stripe_customer_secret).toBeUndefined();
      expect((projected as any).internal_billing_notes).toBeUndefined();
    });
  });

  describe("Strict Schema Runtime Validation", () => {
    it("rejects unknown extra fields injected into customer profile schema", () => {
      const validProfile = {
        id: "a0000000-0000-0000-0000-000000000001",
        name: "Alice",
        status: "ACTIVE",
        lifetime_value_minor: 1000,
        tenure_days: 30,
        opted_out: false,
        email_masked: "a***@e***.com",
        phone_masked: "+1***2345",
      };

      expect(() => CustomerProfileContextSchema.parse(validProfile)).not.toThrow();

      const invalidProfileWithInjectedField = {
        ...validProfile,
        unauthorized_db_column: "leaked_secret_value",
      };

      expect(() =>
        CustomerProfileContextSchema.parse(invalidProfileWithInjectedField),
      ).toThrow();
    });

    it("rejects unknown extra fields at root CustomerContextSchema level", () => {
      const validContext = {
        built_at: "2026-08-27T12:00:00.000Z",
        customer: {
          id: "a0000000-0000-0000-0000-000000000001",
          name: "Alice",
          status: "ACTIVE",
          lifetime_value_minor: 1000,
          tenure_days: 30,
          opted_out: false,
          email_masked: "a***@e***.com",
          phone_masked: "+1***2345",
        },
        payment_summary: {
          succeeded_count_180d: 0,
          failed_count_180d: 0,
          last_success_at: null,
          last_failure_at: null,
          last_failure_code: null,
          avg_amount_minor: 0,
          total_paid_minor: 0,
        },
        subscription_summary: {
          status: null,
          plan_name: null,
          amount_minor: 0,
          renewals_count: 0,
          past_due_events: 0,
        },
        invoice_summary: {
          open_count: 0,
          overdue_count: 0,
          worst_days_overdue: 0,
          total_overdue_minor: 0,
        },
        checkout_summary: {
          active_carts: 0,
          abandoned_count_90d: 0,
          last_cart_value_minor: 0,
        },
        recovery_history: {
          prior_cases: 0,
          recovered_cases: 0,
          stopped_cases: 0,
          escalated_cases: 0,
          last_outcome: null,
          retry_success_rate: 0,
        },
        communication_history: {
          whatsapp_last_7d: 0,
          email_last_14d: 0,
          sms_last_7d: 0,
          last_contacted_at: null,
          reply_rate: 0,
          opt_out_at: null,
        },
        preferences: {
          preferred_channel: null,
          language: "en",
        },
      };

      expect(() => CustomerContextSchema.parse(validContext)).not.toThrow();

      const contextWithInjectedTopLevelField = {
        ...validContext,
        extra_secret_field: "malicious_payload",
      };

      expect(() =>
        CustomerContextSchema.parse(contextWithInjectedTopLevelField),
      ).toThrow();
    });
  });
});
