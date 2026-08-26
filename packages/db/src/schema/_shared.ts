import { customType, timestamp, bigint, char } from "drizzle-orm/pg-core";

/**
 * PostgreSQL case-insensitive text extension type (`citext`).
 * Requires `CREATE EXTENSION IF NOT EXISTS citext;` in migration.
 */
export const citext = customType<{ data: string }>({
  dataType() {
    return "citext";
  },
});

/**
 * Standard audit timestamp columns present on all canonical business tables.
 * `updated_at` automatically maintains update timestamps via Drizzle's `$onUpdate`.
 */
export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
};

/**
 * Standard minor-unit money column pair per ADR-009.
 */
export const moneyColumns = {
  amount: bigint("amount", { mode: "bigint" }).notNull(),
  currency: char("currency", { length: 3 }).notNull(),
};

/**
 * Type interface for tenant settings JSONB payload.
 */
export interface TenantSettings {
  attributionWindowHours?: number;
  timezone?: string;
  contactPrefsDefaults?: {
    channels?: string[];
    quietHoursStartUtc?: number;
    quietHoursEndUtc?: number;
  };
  [key: string]: unknown;
}

/**
 * Type interface for checkout line items JSONB payload.
 */
export interface CheckoutItem {
  sku: string;
  name: string;
  quantity: number;
  unitAmountMinor: number | string;
  [key: string]: unknown;
}
