export type FixtureFactory<T extends object> = (overrides?: Partial<T>) => T;

export function defineFixtureFactory<T extends object>(defaults: () => T): FixtureFactory<T> {
  return (overrides = {}) => ({ ...defaults(), ...overrides });
}
