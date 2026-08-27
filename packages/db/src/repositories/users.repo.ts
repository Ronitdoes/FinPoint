import { and, eq } from "drizzle-orm";
import { users, type User, type NewUser } from "../schema/users";
import { type RepoContext, getExecutor } from "./types";

export interface CreateUserInput {
  tenantId: string;
  email: string;
  name: string;
  role: NewUser["role"];
  passwordHash?: string;
  status?: NewUser["status"];
}

export interface UpdateUserInput {
  tenantId: string;
  userId: string;
  name?: string;
  role?: NewUser["role"];
  passwordHash?: string;
  status?: NewUser["status"];
  lastLoginAt?: Date;
}

export async function createUser(
  ctx: RepoContext,
  input: CreateUserInput,
): Promise<User> {
  const executor = getExecutor(ctx);
  const [created] = await executor
    .insert(users)
    .values({
      tenantId: input.tenantId,
      email: input.email,
      name: input.name,
      role: input.role,
      passwordHash: input.passwordHash,
      status: input.status ?? "ACTIVE",
    })
    .returning();
  return created;
}

export async function findUserById(
  ctx: RepoContext,
  { tenantId, userId }: { tenantId: string; userId: string },
): Promise<User | null> {
  const executor = getExecutor(ctx);
  const [user] = await executor
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
    .limit(1);
  return user ?? null;
}

export async function findUserByEmail(
  ctx: RepoContext,
  { tenantId, email }: { tenantId: string; email: string },
): Promise<User | null> {
  const executor = getExecutor(ctx);
  const [user] = await executor
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.email, email)))
    .limit(1);
  return user ?? null;
}

export async function findUserByEmailGlobal(
  ctx: RepoContext,
  { email }: { email: string },
): Promise<User | null> {
  const executor = getExecutor(ctx);
  const [user] = await executor
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return user ?? null;
}

export async function findUserByIdGlobal(
  ctx: RepoContext,
  { userId }: { userId: string },
): Promise<User | null> {
  const executor = getExecutor(ctx);
  const [user] = await executor
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return user ?? null;
}

export async function updateUser(
  ctx: RepoContext,
  input: UpdateUserInput,
): Promise<User | null> {
  const executor = getExecutor(ctx);
  const updateData: Partial<NewUser> = {
    updatedAt: new Date(),
  };
  if (input.name !== undefined) updateData.name = input.name;
  if (input.role !== undefined) updateData.role = input.role;
  if (input.passwordHash !== undefined) updateData.passwordHash = input.passwordHash;
  if (input.status !== undefined) updateData.status = input.status;
  if (input.lastLoginAt !== undefined) updateData.lastLoginAt = input.lastLoginAt;

  const [updated] = await executor
    .update(users)
    .set(updateData)
    .where(and(eq(users.tenantId, input.tenantId), eq(users.id, input.userId)))
    .returning();
  return updated ?? null;
}

export async function listUsersByTenant(
  ctx: RepoContext,
  { tenantId, limit = 50, offset = 0 }: { tenantId: string; limit?: number; offset?: number },
): Promise<User[]> {
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(users)
    .where(eq(users.tenantId, tenantId))
    .limit(limit)
    .offset(offset);
}
