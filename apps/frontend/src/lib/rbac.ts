import type { UserRole } from "./types";

export const PERMISSION_ACTIONS = [
  "READ_CASES_ANALYTICS",
  "PAUSE_RESUME_CASE",
  "ESCALATE_CASE",
  "STOP_CASE",
  "APPROVE_HUMAN_TASK",
  "MANAGE_POLICIES",
  "MANAGE_USERS_API_KEYS",
  "TRIGGER_REPLAY_DEMO",
] as const;

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export const ROLE_PERMISSIONS: Readonly<Record<UserRole, ReadonlySet<PermissionAction>>> = {
  VIEWER: new Set<PermissionAction>(["READ_CASES_ANALYTICS"]),
  SUPPORT: new Set<PermissionAction>(["READ_CASES_ANALYTICS", "ESCALATE_CASE"]),
  OPERATIONS: new Set<PermissionAction>([
    "READ_CASES_ANALYTICS",
    "PAUSE_RESUME_CASE",
    "ESCALATE_CASE",
    "APPROVE_HUMAN_TASK",
    "TRIGGER_REPLAY_DEMO",
  ]),
  FINANCE: new Set<PermissionAction>([
    "READ_CASES_ANALYTICS",
    "PAUSE_RESUME_CASE",
    "ESCALATE_CASE",
    "STOP_CASE",
    "APPROVE_HUMAN_TASK",
    "MANAGE_POLICIES",
    "TRIGGER_REPLAY_DEMO",
  ]),
  ADMIN: new Set<PermissionAction>([
    "READ_CASES_ANALYTICS",
    "PAUSE_RESUME_CASE",
    "ESCALATE_CASE",
    "STOP_CASE",
    "APPROVE_HUMAN_TASK",
    "MANAGE_POLICIES",
    "MANAGE_USERS_API_KEYS",
    "TRIGGER_REPLAY_DEMO",
  ]),
};

/**
 * Evaluates whether a role is authorized to perform a given permission action on the client (UX gating).
 * Server remains the final enforcement authority.
 */
export function hasPermission(role: UserRole | string | undefined | null, action: PermissionAction): boolean {
  if (!role) return false;
  const userRole = role as UserRole;
  const perms = ROLE_PERMISSIONS[userRole];
  return perms ? perms.has(action) : false;
}

export function canPauseResume(role: UserRole | string | undefined | null): boolean {
  return hasPermission(role, "PAUSE_RESUME_CASE");
}

export function canEscalate(role: UserRole | string | undefined | null): boolean {
  return hasPermission(role, "ESCALATE_CASE");
}

export function canStop(role: UserRole | string | undefined | null): boolean {
  return hasPermission(role, "STOP_CASE");
}

export function canApproveTasks(role: UserRole | string | undefined | null): boolean {
  return hasPermission(role, "APPROVE_HUMAN_TASK");
}

export function canManagePolicies(role: UserRole | string | undefined | null): boolean {
  return hasPermission(role, "MANAGE_POLICIES");
}

export function canManageAdmin(role: UserRole | string | undefined | null): boolean {
  return hasPermission(role, "MANAGE_USERS_API_KEYS");
}
