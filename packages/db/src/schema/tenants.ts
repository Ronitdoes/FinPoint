import { jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { tenantStatusEnum } from "./enums";
import { timestamps, type TenantSettings } from "./_shared";

/**
 * Tenants table — top-level tenancy boundary (Spec 02 §15).
 * Every business record in the platform scopes to a tenant via tenant_id.
 */
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  status: tenantStatusEnum("status").notNull().default("ACTIVE"),
  settings: jsonb("settings").$type<TenantSettings>().notNull().default({}),
  ...timestamps,
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
