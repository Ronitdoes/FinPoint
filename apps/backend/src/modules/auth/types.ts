import { z } from "zod";
import type { UserRole } from "@repo/domain";
import type { RequestAuth } from "../../plugins/auth";

export const loginSchema = z.object({
  email: z.string().email("A valid email address is required"),
  password: z.string().min(1, "Password is required"),
});

export type LoginInput = z.infer<typeof loginSchema>;

export interface AuthUserSummary {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  tenantId: string;
  status: string;
}

export interface LoginResponse {
  user: AuthUserSummary;
}

export interface MeResponse {
  user: AuthUserSummary;
  auth: RequestAuth;
}
