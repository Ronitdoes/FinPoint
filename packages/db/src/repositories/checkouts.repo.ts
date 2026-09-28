import { and, desc, eq } from "drizzle-orm";
import {
  checkouts,
  checkoutEvents,
  type Checkout,
  type NewCheckout,
  type CheckoutEvent,
  type NewCheckoutEvent,
} from "../schema/checkouts";
import { type RepoContext, getExecutor } from "./types";

export interface CreateCheckoutInput {
  tenantId: string;
  customerId: string;
  cartValue?: bigint;
  currency: string;
  items?: NewCheckout["items"];
  status?: NewCheckout["status"];
  sourceRef?: string;
  startedAt: Date;
  lastActivityAt: Date;
  completedAt?: Date;
  abandonedAt?: Date;
  expiresAt?: Date;
}

export interface UpdateCheckoutStatusInput {
  tenantId: string;
  checkoutId: string;
  status: NewCheckout["status"];
  lastActivityAt?: Date;
  completedAt?: Date;
  abandonedAt?: Date;
}

export interface RecordCheckoutEventInput {
  tenantId: string;
  checkoutId: string;
  type: string;
  payload?: Record<string, unknown>;
  occurredAt?: Date;
}

export async function createCheckout(
  ctx: RepoContext,
  input: CreateCheckoutInput,
): Promise<Checkout> {
  const executor = getExecutor(ctx);
  const [created] = await executor
    .insert(checkouts)
    .values({
      tenantId: input.tenantId,
      customerId: input.customerId,
      cartValue: input.cartValue ?? 0n,
      currency: input.currency,
      items: input.items ?? [],
      status: input.status ?? "STARTED",
      sourceRef: input.sourceRef,
      startedAt: input.startedAt,
      lastActivityAt: input.lastActivityAt,
      completedAt: input.completedAt,
      abandonedAt: input.abandonedAt,
      expiresAt: input.expiresAt,
    })
    .returning();
  return created;
}

export async function findCheckoutById(
  ctx: RepoContext,
  { tenantId, checkoutId }: { tenantId: string; checkoutId: string },
): Promise<Checkout | null> {
  const executor = getExecutor(ctx);
  const [checkout] = await executor
    .select()
    .from(checkouts)
    .where(
      and(eq(checkouts.tenantId, tenantId), eq(checkouts.id, checkoutId)),
    )
    .limit(1);
  return checkout ?? null;
}

export async function findCheckoutBySourceRef(
  ctx: RepoContext,
  { tenantId, sourceRef }: { tenantId: string; sourceRef: string },
): Promise<Checkout | null> {
  const executor = getExecutor(ctx);
  const [checkout] = await executor
    .select()
    .from(checkouts)
    .where(
      and(eq(checkouts.tenantId, tenantId), eq(checkouts.sourceRef, sourceRef)),
    )
    .limit(1);
  return checkout ?? null;
}

/**
 * App-guarded status write (NOT a DB-guarded transition — intentional).
 *
 * Checkout rows mirror shopper-side state where recovery can legitimately move a cart
 * backwards (ABANDONED → PAYMENT_STARTED → COMPLETED). The transition allowlist lives
 * app-side in `apps/backend/src/modules/webhooks/core-upserts.ts`
 * (CHECKOUT_ALLOWED_TRANSITIONS), which skips regressions and records an
 * order-regression metric instead of writing.
 *
 * Dedupe anchor: `checkouts_tenant_source_ref_unique` — one row per shop cart, so
 * concurrent ingests converge on the existing row before this write runs.
 * See packages/db/README.md §4 for the DB-guarded vs app-guarded split.
 */
export async function updateCheckoutStatus(
  ctx: RepoContext,
  input: UpdateCheckoutStatusInput,
): Promise<Checkout | null> {
  const executor = getExecutor(ctx);
  const updateData: Partial<NewCheckout> = {
    status: input.status,
    updatedAt: new Date(),
  };
  if (input.lastActivityAt !== undefined)
    updateData.lastActivityAt = input.lastActivityAt;
  if (input.completedAt !== undefined) updateData.completedAt = input.completedAt;
  if (input.abandonedAt !== undefined) updateData.abandonedAt = input.abandonedAt;

  const [updated] = await executor
    .update(checkouts)
    .set(updateData)
    .where(
      and(
        eq(checkouts.tenantId, input.tenantId),
        eq(checkouts.id, input.checkoutId),
      ),
    )
    .returning();
  return updated ?? null;
}

/**
 * Appends a checkout event to the immutable cart ledger (append-only).
 */
export async function recordCheckoutEvent(
  ctx: RepoContext,
  input: RecordCheckoutEventInput,
): Promise<CheckoutEvent> {
  const executor = getExecutor(ctx);
  const [event] = await executor
    .insert(checkoutEvents)
    .values({
      checkoutId: input.checkoutId,
      type: input.type,
      payload: input.payload ?? {},
      occurredAt: input.occurredAt ?? new Date(),
    })
    .returning();
  return event;
}

/**
 * Lists chronological checkout events for a checkout (append-only reader).
 */
export async function listCheckoutEvents(
  ctx: RepoContext,
  { checkoutId }: { checkoutId: string },
): Promise<CheckoutEvent[]> {
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(checkoutEvents)
    .where(eq(checkoutEvents.checkoutId, checkoutId))
    .orderBy(checkoutEvents.occurredAt);
}

export async function listCheckoutsForCustomer(
  ctx: RepoContext,
  {
    tenantId,
    customerId,
    limit = 50,
    offset = 0,
  }: { tenantId: string; customerId: string; limit?: number; offset?: number },
): Promise<Checkout[]> {
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(checkouts)
    .where(and(eq(checkouts.tenantId, tenantId), eq(checkouts.customerId, customerId)))
    .orderBy(desc(checkouts.lastActivityAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Checks if a checkout is eligible to be watched by an abandonment workflow.
 * Ensures duplicate checkout.started events do not spawn multiple workflows.
 */
export async function findWatchable(
  ctx: RepoContext,
  { tenantId, checkoutId }: { tenantId: string; checkoutId: string },
): Promise<{ watchable: boolean; checkout: Checkout | null; alreadyStarted: boolean }> {
  const checkout = await findCheckoutById(ctx, { tenantId, checkoutId });
  if (!checkout || checkout.status === "COMPLETED") {
    return { watchable: false, checkout, alreadyStarted: false };
  }
  const events = await listCheckoutEvents(ctx, { checkoutId });
  const alreadyStarted = events.some(
    (e) =>
      e.type === "WATCH_STARTED" ||
      (e.payload as Record<string, unknown> | null)?.abandonment_workflow_started === true,
  );
  return {
    watchable: !alreadyStarted && checkout.status === "STARTED",
    checkout,
    alreadyStarted,
  };
}

/**
 * Records that a recovery message/contact was dispatched for this checkout (Spec 23 §7).
 */
export async function markContacted(
  ctx: RepoContext,
  {
    tenantId,
    checkoutId,
    step = "1",
    contactedAt = new Date(),
  }: { tenantId: string; checkoutId: string; step?: string; contactedAt?: Date },
): Promise<CheckoutEvent> {
  return await recordCheckoutEvent(ctx, {
    tenantId,
    checkoutId,
    type: "RECOVERY_CONTACTED",
    payload: {
      recovery_contacted_at: contactedAt.toISOString(),
      step,
    },
    occurredAt: contactedAt,
  });
}

/**
 * Best-effort completion race guard (Spec 23 §7; s-23.md:41 concedes a best-effort window).
 * Re-reads checkout status and completedAt immediately before send; if completed between
 * check and send, returns safeToSend=false so the workflow aborts outbound communication.
 *
 * Step labels: "1" = REMINDER (Touch 1), "2" = INCENTIVE (Touch 2). The legacy
 * "REMINDER"/"INCENTIVE" names are accepted as aliases and normalized to "1"/"2" for
 * ledger consistency (message keys are `{tenant}:{case}:{channel}:{template}:1|2`).
 *
 * Best-effort note: the check and the RECOVERY_CONTACTED ledger insert run in the
 * caller's transaction but WITHOUT SELECT FOR UPDATE row locking, and the actual
 * provider send happens in a later activity. A purchase landing in that window is caught
 * by the post-wait fresh-DB re-read + external-checkout-completed signal wakeup, which
 * converges to RECOVERED without duplicate sends. Do not claim full atomicity here.
 */
export async function completeRaceGuard(
  ctx: RepoContext,
  {
    tenantId,
    checkoutId,
    step = "1",
  }: { tenantId: string; checkoutId: string; step?: string },
): Promise<{ safeToSend: boolean; checkout: Checkout | null; completedAt?: Date }> {
  // Normalize legacy labels: REMINDER -> "1", INCENTIVE -> "2".
  const normalizedStep =
    step === "REMINDER" ? "1" : step === "INCENTIVE" ? "2" : step;
  const checkout = await findCheckoutById(ctx, { tenantId, checkoutId });
  if (!checkout) {
    return { safeToSend: false, checkout: null };
  }
  if (checkout.status === "COMPLETED" || checkout.completedAt !== null) {
    return {
      safeToSend: false,
      checkout,
      completedAt: checkout.completedAt ?? undefined,
    };
  }

  // Record contact attempt to ledger (best-effort flag, not an atomic send gate).
  await markContacted(ctx, { tenantId, checkoutId, step: normalizedStep });

  return { safeToSend: true, checkout };
}

