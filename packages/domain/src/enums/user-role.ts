export const USER_ROLES = [
  "ADMIN",
  "FINANCE",
  "OPERATIONS",
  "SUPPORT",
  "VIEWER",
] as const;

export type UserRole = (typeof USER_ROLES)[number];

export const UserRole = Object.freeze(
  Object.fromEntries(USER_ROLES.map((value) => [value, value])),
) as Readonly<Record<UserRole, UserRole>>;
