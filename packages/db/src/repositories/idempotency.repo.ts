import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import {
  idempotencyKeys,
  type IdempotencyKey,
  type NewIdempotencyKey,
} from "../schema/idempotency";
import { type RepoContext, getExecutor } from "./types";

export type AcquireResult = "ACQUIRED" | "IN_FLIGHT" | "COMPLETED_DIFFERENT";

export interface TryAcquireInput {
  key: string;
  requestHash: string;
  ttlSeconds?: number;
}

export interface CompleteIdempotencyInput {
  key: string;
  responseSnapshot: Record<string, unknown>;
  ttlSeconds?: number;
}

/**
 * Attempts to acquire an idempotency key with lease locking semantics.
 *
 * Returns:
 * - 'ACQUIRED': Successfully acquired ownership to process the request.
 * - 'IN_FLIGHT': Another process holds an active lease or request is already completed.
 * - 'COMPLETED_DIFFERENT': Key was already used with a different request payload/hash.
 */
export async function tryAcquire(
  ctx: RepoContext,
  { key, requestHash, ttlSeconds = 60 }: TryAcquireInput,
): Promise<AcquireResult> {
  const executor = getExecutor(ctx);
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + ttlSeconds * 1000);
  const expiresAt = new Date(now.getTime() + Math.max(ttlSeconds * 10, 86400) * 1000);

  // Attempt initial insert
  const inserted = await executor
    .insert(idempotencyKeys)
    .values({
      key,
      requestHash,
      status: "PROCESSING",
      lockedUntil,
      expiresAt,
    })
    .onConflictDoNothing({
      target: idempotencyKeys.key,
    })
    .returning();

  if (inserted.length > 0) {
    return "ACQUIRED";
  }

  // Key exists: check status and lease expiration
  const [existing] = await executor
    .select()
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, key))
    .limit(1);

  if (!existing) {
    return "IN_FLIGHT";
  }

  // Request payload changed under same idempotency key
  if (existing.requestHash !== requestHash) {
    return "COMPLETED_DIFFERENT";
  }

  // Already completed
  if (existing.status === "COMPLETED") {
    return "IN_FLIGHT";
  }

  // Check if active lease is held
  if (existing.lockedUntil && existing.lockedUntil > now) {
    return "IN_FLIGHT";
  }

  // Lease expired past crash / timeout: attempt to re-acquire
  const [reacquired] = await executor
    .update(idempotencyKeys)
    .set({
      status: "PROCESSING",
      requestHash,
      lockedUntil,
      expiresAt,
    })
    .where(
      and(
        eq(idempotencyKeys.key, key),
        or(
          isNull(idempotencyKeys.lockedUntil),
          lte(idempotencyKeys.lockedUntil, now),
        ),
      ),
    )
    .returning();

  return reacquired ? "ACQUIRED" : "IN_FLIGHT";
}

/**
 * Marks an idempotency key as COMPLETED with the resulting response snapshot.
 */
export async function complete(
  ctx: RepoContext,
  input: CompleteIdempotencyInput,
): Promise<IdempotencyKey | null> {
  const executor = getExecutor(ctx);
  const updateData: Partial<NewIdempotencyKey> = {
    status: "COMPLETED",
    responseSnapshot: input.responseSnapshot,
    lockedUntil: null,
  };
  if (input.ttlSeconds) {
    updateData.expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
  }

  const [completed] = await executor
    .update(idempotencyKeys)
    .set(updateData)
    .where(eq(idempotencyKeys.key, input.key))
    .returning();

  return completed ?? null;
}

/**
 * Releases an in-flight lease so the operation can be retried immediately.
 */
export async function releaseLease(
  ctx: RepoContext,
  { key }: { key: string },
): Promise<void> {
  const executor = getExecutor(ctx);
  await executor
    .delete(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.key, key),
        eq(idempotencyKeys.status, "PROCESSING"),
      ),
    );
}

/**
 * Retrieves the stored response snapshot for a completed idempotency key.
 */
export async function getResponseSnapshot(
  ctx: RepoContext,
  { key }: { key: string },
): Promise<Record<string, unknown> | null> {
  const executor = getExecutor(ctx);
  const [row] = await executor
    .select()
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, key))
    .limit(1);

  if (!row || row.status !== "COMPLETED") {
    return null;
  }
  return row.responseSnapshot ?? null;
}
