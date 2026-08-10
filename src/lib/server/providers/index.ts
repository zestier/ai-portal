import { copilotProvider } from '../copilot/copilot-provider';
import { createClaudeAgentProvider, claudeAgentProvider } from './claude-agent-provider';
import { createLMStudioProvider, lmStudioProvider } from './lm-studio-provider';
import {
	createOpenAICompatibleProvider,
	openAICompatibleProvider
} from './openai-compatible-provider';
import type { BackendProviderId, ProviderInstance } from '$lib/types';
import { getDefaultInstanceId, getInstance, listInstances } from './registry';
import type {
	ModelBackendProvider,
	ProviderAuthStatus,
	ProviderModelInfo,
	ProviderOpenOptions,
	ProviderSession
} from './provider';

export type {
	ModelBackendProvider,
	ProviderAuthStatus,
	ProviderCapabilities,
	ProviderModelInfo,
	ProviderOpenOptions,
	ProviderStatusBehavior,
	ProviderSession,
	ProviderUiInfo
} from './provider';

const builtinProviders: Record<BackendProviderId, ModelBackendProvider> = {
	copilot: copilotProvider,
	'claude-agent': claudeAgentProvider,
	'openai-compatible': openAICompatibleProvider,
	'lm-studio': lmStudioProvider
};

/**
 * Resolve an instance to its provider object. Built-in instances (id === type)
 * return the module singleton so existing references/test spies stay stable;
 * ZAP_PROVIDERS_JSON instances get a fresh factory object capturing their
 * instance config in the closure.
 */
function providerFor(instance: ProviderInstance): ModelBackendProvider {
	if (instance.id === instance.type) return builtinProviders[instance.type];
	switch (instance.type) {
		case 'claude-agent':
			return createClaudeAgentProvider(instance);
		case 'openai-compatible':
			return createOpenAICompatibleProvider(instance);
		case 'lm-studio':
			return createLMStudioProvider(instance);
		case 'copilot':
			return copilotProvider;
	}
}

export function listProviders(): ModelBackendProvider[] {
	return listInstances().map(providerFor);
}

export function getProvider(id: string | null | undefined): ModelBackendProvider {
	// Unknown ids resolve to the default instance, matching how
	// normalizeProviderInstance coerces stored values (a legacy bare type id is
	// itself a built-in instance id, so it matches here).
	const instance = getInstance(id) ?? getInstance(getDefaultInstanceId())!;
	return providerFor(instance);
}

export function getDefaultProviderId(): string {
	return getDefaultInstanceId();
}

export function getDefaultProvider(): ModelBackendProvider {
	return getProvider(getDefaultProviderId());
}

export async function fetchAuthStatus(
	userId: string,
	providerAuthToken?: string,
	provider: string = getDefaultProviderId()
): Promise<ProviderAuthStatus> {
	return getProvider(provider).fetchAuthStatus(userId, providerAuthToken);
}

export async function fetchModels(
	userId: string,
	providerAuthToken?: string,
	provider: string = getDefaultProviderId()
): Promise<ProviderModelInfo[]> {
	return getProvider(provider).listModels(userId, providerAuthToken);
}

export async function open(opts: ProviderOpenOptions): Promise<ProviderSession> {
	return getProvider(opts.provider).openSession(opts);
}

export async function shutdownProviders(): Promise<void> {
	await Promise.all(listProviders().map((provider) => provider.shutdown?.()));
}
