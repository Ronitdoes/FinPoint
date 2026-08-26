export const ACTOR_TYPES = ["SYSTEM", "AI", "USER", "WORKFLOW", "PROVIDER"] as const;

export type ActorType = (typeof ACTOR_TYPES)[number];

export const ActorType = Object.freeze(
  Object.fromEntries(ACTOR_TYPES.map((value) => [value, value])),
) as Readonly<Record<ActorType, ActorType>>;
