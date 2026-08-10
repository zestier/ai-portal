// Provider instance registry.
//
// Identity and type are separate: `BackendProviderId` names the implementation,
// while an instance id names one CONFIGURED backend (conversations and settings
// store the instance id). The built-in instances reuse their type id as their
// instance id and read their endpoint config from the environment at call time,
// so a legacy env-only deployment resolves exactly as before. `ZAP_PROVIDERS_JSON`
// adds extra instances of any type.
//
// This module is a leaf: it imports only config + types, so DB repos and the
// shadow module can import it without creating a cycle through `providers/index`
// (which imports every provider implementation).

import { loadConfig } from '../config';
import type { ProviderInstance } from '$lib/types';

const BUILTIN_INSTANCES: ProviderInstance[] = [
	{ id: 'copilot', type: 'copilot' },
	{ id: 'claude-agent', type: 'claude-agent' },
	{ id: 'openai-compatible', type: 'openai-compatible' },
	{ id: 'lm-studio', type: 'lm-studio' }
];

/** Every configured instance: the built-ins (in fixed order) then `ZAP_PROVIDERS_JSON`. */
export function listInstances(): ProviderInstance[] {
	const cfg = loadConfig();
	return [...BUILTIN_INSTANCES, ...cfg.ZAP_PROVIDERS_JSON];
}

export function getInstance(id: string | null | undefined): ProviderInstance | undefined {
	if (!id) return undefined;
	return listInstances().find((instance) => instance.id === id);
}

/**
 * Coerce a stored/configured provider reference into a known instance id.
 * A bare type id resolves to that type's built-in instance; anything unknown
 * falls back to the deployment default instance. This is the storage-side
 * replacement for `normalizeBackendProvider`.
 */
export function normalizeProviderInstance(raw: string | null | undefined): string {
	return getInstance(raw)?.id ?? getDefaultInstanceId();
}

/** The effective default instance id, from `DEFAULT_BACKEND_PROVIDER`. */
export function getDefaultInstanceId(): string {
	// Unknown configured values fall back to the copilot built-in (never recurse
	// into `normalizeProviderInstance`, which falls back to THIS function).
	const raw = loadConfig().DEFAULT_BACKEND_PROVIDER;
	return getInstance(raw)?.id ?? 'copilot';
}
