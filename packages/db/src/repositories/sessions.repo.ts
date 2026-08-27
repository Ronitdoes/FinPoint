import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { userSessions, type UserSession, type NewUserSession } from "../schema/sessions";
import { users, type User } from "../schema/users";
import { type RepoContext, getExecutor } from "./types";

export interface CreateSessionInput {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  ip?: string | null;
  userAgent?: string | null;
}

export interface SessionWithUser {
  session: UserSession;
  user: User;
}

export async function createSession(
  ctx: RepoContext,
  input: CreateSessionInput,
): Promise<UserSession> {
  const executor = getExecutor(ctx);
  const [created] = await executor
    .insert(userSessions)
    .values({
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    })
    .returning();
  return created;
}

export async function findSessionByTokenHash(
  ctx: RepoContext,
  { tokenHash }: { tokenHash: string },
): Promise<SessionWithUser | null> {
  const executor = getExecutor(ctx);
  const rows = await executor
    .select({
      session: userSessions,
      user: users,
    })
    .from(userSessions)
    .innerJoin(users, eq(userSessions.userId, users.id))
    .where(
      and(
        eq(userSessions.tokenHash, tokenHash),
        isNull(userSessions.revokedAt),
        gt(userSessions.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!rows.length || !rows[0]) {
    return null;
  }

  return {
    session: rows[0].session,
    user: rows[0].user,
  };
}

export async function revokeSession(
  ctx: RepoContext,
  { id }: { id: string },
): Promise<UserSession | null> {
  const executor = getExecutor(ctx);
  const [revoked] = await executor
    .update(userSessions)
    .set({
      revokedAt: new Date(),
    })
    .where(eq(userSessions.id, id))
    .returning();
  return revoked ?? null;
}

export async function revokeSessionByTokenHash(
  ctx: RepoContext,
  { tokenHash }: { tokenHash: string },
): Promise<UserSession | null> {
  const executor = getExecutor(ctx);
  const [revoked] = await executor
    .update(userSessions)
    .set({
      revokedAt: new Date(),
    })
    .where(eq(userSessions.tokenHash, tokenHash))
    .returning();
  return revoked ?? null;
}

export async function revokeAllUserSessions(
  ctx: RepoContext,
  { userId }: { userId: string },
): Promise<number> {
  const executor = getExecutor(ctx);
  const rows = await executor
    .update(userSessions)
    .set({
      revokedAt: new Date(),
    })
    .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)))
    .returning({ id: userSessions.id });
  return rows.length;
}

export async function updateSessionExpiry(
  ctx: RepoContext,
  { id, expiresAt }: { id: string; expiresAt: Date },
): Promise<UserSession | null> {
  const executor = getExecutor(ctx);
  const [updated] = await executor
    .update(userSessions)
    .set({
      expiresAt,
    })
    .where(and(eq(userSessions.id, id), isNull(userSessions.revokedAt)))
    .returning();
  return updated ?? null;
}

export async function cleanupExpiredSessions(ctx: RepoContext): Promise<number> {
  const executor = getExecutor(ctx);
  const rows = await executor
    .delete(userSessions)
    .where(lt(userSessions.expiresAt, new Date()))
    .returning({ id: userSessions.id });
  return rows.length;
}
