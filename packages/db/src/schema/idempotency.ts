import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { idempotencyKeyStatusEnum } from "./enums";

/**
 * Idempotency Keys table — generic idempotency store for async/HTTP endpoints (Spec 01 §5, §21).
 * Features lease-locking support via locked_until and response snapshots.
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    key: text("key").primaryKey(),
    requestHash: text("request_hash").notNull(),
    responseSnapshot: jsonb("response_snapshot").$type<
      Record<string, unknown>
    >(),
    status: idempotencyKeyStatusEnum("status")
      .notNull()
      .default("PROCESSING"),
    lockedUntil: timestamp("locked_until", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (table) => [
    index("idempotency_keys_expires_at_idx").on(table.expiresAt),
  ],
);

export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type NewIdempotencyKey = typeof idempotencyKeys.$inferInsert;
