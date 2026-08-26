import {
  bigint,
  char,
  check,
  date,
  index,
  pgTable,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants";
import { recoveryCases } from "./cases";
import { payments } from "./payments";
import { promiseToPayStatusEnum } from "./enums";
import { timestamps } from "./_shared";

/**
 * Promises to Pay table — customer repayment commitments (Spec 01 §5, Spec 02 §3).
 * Links to honored payment upon successful settlement.
 */
export const promisesToPay = pgTable(
  "promises_to_pay",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => recoveryCases.id, { onDelete: "restrict" }),
    promisedAmount: bigint("promised_amount", { mode: "bigint" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    promisedByDate: date("promised_by_date").notNull(),
    status: promiseToPayStatusEnum("status").notNull().default("MADE"),
    honoredPaymentId: uuid("honored_payment_id").references(
      () => payments.id,
      { onDelete: "set null" },
    ),
    resolvedAt: timestamp("resolved_at", {
      withTimezone: true,
      mode: "date",
    }),
    ...timestamps,
  },
  (table) => [
    check(
      "promises_to_pay_amount_check",
      sql`${table.promisedAmount} > 0`,
    ),
    index("promises_to_pay_case_id_idx").on(table.caseId),
    index("promises_to_pay_tenant_id_idx").on(table.tenantId),
  ],
);

export type PromiseToPay = typeof promisesToPay.$inferSelect;
export type NewPromiseToPay = typeof promisesToPay.$inferInsert;
