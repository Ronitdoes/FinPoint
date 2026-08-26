import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants";
import { customerStatusEnum } from "./enums";
import { citext, timestamps } from "./_shared";

/**
 * Customers table — canonical customer profile and communication state.
 * Includes opt-out state (Spec 02 §7) and soft-delete (deleted_at).
 */
export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    externalRef: text("external_ref"),
    name: text("name").notNull(),
    email: citext("email"),
    phone: text("phone"),
    status: customerStatusEnum("status").notNull().default("ACTIVE"),
    lifetimeValue: bigint("lifetime_value", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    optedOut: boolean("opted_out").notNull().default(false),
    optedOutAt: timestamp("opted_out_at", { withTimezone: true, mode: "date" }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("customers_tenant_external_ref_unique")
      .on(table.tenantId, table.externalRef)
      .where(sql`external_ref IS NOT NULL`),
    index("customers_tenant_email_idx").on(table.tenantId, table.email),
    index("customers_tenant_phone_idx").on(table.tenantId, table.phone),
    index("customers_tenant_id_idx").on(table.tenantId),
  ],
);

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
