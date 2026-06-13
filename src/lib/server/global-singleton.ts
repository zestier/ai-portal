const APP_GLOBAL_PREFIXES = ['zap', 'command-deck', 'agent-portal', 'copilot-portal'] as const;

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

export function getOrCreateGlobalSingleton<T>(keys: readonly symbol[], create: () => T): T {
	const existing = getGlobalSingletonValue<T>(keys);
	if (existing != null) return existing;

	const value = create();
	setGlobalSingletonValue(keys, value);
	return value;
}

export function setGlobalSingletonValue<T>(keys: readonly symbol[], value: T): void {
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
