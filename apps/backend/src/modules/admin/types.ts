import { z } from "zod";
import { USER_ROLES, USER_STATUSES, type UserRole, type UserStatus } from "@repo/domain";

export const createUserSchema = z.object({
  email: z.string().email("A valid email address is required"),
  name: z.string().min(1, "Name is required"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  role: z.enum(USER_ROLES),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.enum(USER_ROLES).optional(),
  status: z.enum(USER_STATUSES).optional(),
});

export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const createApiKeySchema = z.object({
  name: z.string().min(1, "API key name is required"),
  scopes: z.array(z.string()).optional(),
});

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

export interface AdminUserResponse {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  tenantId: string;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatedApiKeyResponse {
  id: string;
  name: string;
  key: string; // Plaintext token shown ONCE at creation
  prefix: string;
  scopes: string[];
  createdAt: Date;
}

export interface ApiKeySummaryResponse {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}
