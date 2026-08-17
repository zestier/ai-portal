const APP_GLOBAL_PREFIXES = ["zap", "command-deck", "agent-portal"] as const;

type GlobalSlot = Record<symbol, unknown>;

export function appGlobalSymbols(name: string): symbol[] {
  return APP_GLOBAL_PREFIXES.map((prefix) => Symbol.for(`${prefix}.${name}`));
}

export function getGlobalSingletonValue<T>(keys: readonly symbol[]): T | null {
  const globals = globalThis as unknown as GlobalSlot;
  for (const key of keys) {
    const value = globals[key];
    if (value != null) return value as T;
  }
  return null;
}

/**
 * Retrieve or create a global singleton for `keys`. The `create` factory must
 * return a non-null, non-undefined value — a null/undefined result would be
 * stored but then treated as "unset" by the `!= null` guard on the next call,
 * re-running `create()` and its side effects. An assertion fires at runtime to
 * surface this early, and the TypeScript signature enforces it at compile time.
 */
export function getOrCreateGlobalSingleton<T>(
  keys: readonly symbol[],
  create: () => NonNullable<T>,
): NonNullable<T> {
  const existing = getGlobalSingletonValue<NonNullable<T>>(keys);
  if (existing != null) return existing;

  const value = create();
  if (value == null) {
    throw new Error(
      `getOrCreateGlobalSingleton: factory returned ${value} for key "${String(keys[0])}". ` +
        "Null/undefined cannot be cached unambiguously — return a non-null sentinel instead.",
    );
  }
  setGlobalSingletonValue(keys, value);
  return value;
}

export function setGlobalSingletonValue<T>(
  keys: readonly symbol[],
  value: T,
): void {
  const globals = globalThis as unknown as GlobalSlot;
  for (const key of keys.slice(1)) {
    delete globals[key];
  }
  globals[keys[0]] = value;
}

export function clearGlobalSingletonValues(keys: readonly symbol[]): void {
  const globals = globalThis as unknown as GlobalSlot;
  for (const key of keys) {
    delete globals[key];
  }
}
