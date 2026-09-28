import type { UserRole } from "../enums/user-role";

/**
 * Domain Permission Actions (Spec 01 §22 and Step 09).
 *
 * Note (s-09 audit G-09-1, non-breaking): STOP_CASE (FINANCE + ADMIN only) is
 * a deliberate superset beyond the s-09 spec table — spec semantics for all
 * listed actions are unchanged. Covered exhaustively in matrix.test.ts.
 */
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

export const PermissionAction = Object.freeze(
  Object.fromEntries(PERMISSION_ACTIONS.map((a) => [a, a])),
) as Readonly<Record<PermissionAction, PermissionAction>>;

/**
 * Explicit Role -> Allowed Actions mapping.
 *
 *                     VIEWER  SUPPORT  OPERATIONS  FINANCE  ADMIN
 * read cases/analytics   ✓       ✓         ✓          ✓       ✓
 * pause/resume case      ✗       ✗         ✓          ✓       ✓
 * escalate case          ✗       ✓         ✓          ✓       ✓
 * stop case              ✗       ✗         ✗          ✓       ✓
 * approve human task     ✗       ✗         ✓          ✓       ✓
 * manage policies        ✗       ✗         ✗          ✓       ✓
 * manage users/api keys  ✗       ✗         ✗          ✗       ✓
 * trigger replay/demo    ✗       ✗         ✓          ✓       ✓
 */
export const ROLE_PERMISSIONS: Readonly<Record<UserRole, ReadonlySet<PermissionAction>>> =
  Object.freeze({
    VIEWER: new Set<PermissionAction>(["READ_CASES_ANALYTICS"]),
    SUPPORT: new Set<PermissionAction>([
      "READ_CASES_ANALYTICS",
      "ESCALATE_CASE",
    ]),
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
  });

/**
 * Evaluates whether a role is authorized to perform a given permission action.
 */
export function hasPermission(role: UserRole, action: PermissionAction): boolean {
  const permissions = ROLE_PERMISSIONS[role];
  return permissions ? permissions.has(action) : false;
}

/**
 * Returns list of roles authorized for a specific action.
 */
export function getRolesWithPermission(action: PermissionAction): UserRole[] {
  return (Object.keys(ROLE_PERMISSIONS) as UserRole[]).filter((role) =>
    ROLE_PERMISSIONS[role].has(action),
  );
}
