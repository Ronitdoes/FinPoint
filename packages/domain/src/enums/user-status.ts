export const USER_STATUSES = ["ACTIVE", "DISABLED"] as const;

export type UserStatus = (typeof USER_STATUSES)[number];

export const UserStatus = Object.freeze(
  Object.fromEntries(USER_STATUSES.map((value) => [value, value])),
) as Readonly<Record<UserStatus, UserStatus>>;
