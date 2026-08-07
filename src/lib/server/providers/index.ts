import { copilotProvider } from '../copilot/copilot-provider';
import { claudeAgentProvider } from './claude-agent-provider';
import { lmStudioProvider } from './lm-studio-provider';
import { openAICompatibleProvider } from './openai-compatible-provider';
import { loadConfig } from '../config';
import { normalizeBackendProvider, type BackendProviderId } from '$lib/types';
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

const providers: Record<BackendProviderId, ModelBackendProvider> = {
	copilot: copilotProvider,
	'claude-agent': claudeAgentProvider,
	'openai-compatible': openAICompatibleProvider,
	'lm-studio': lmStudioProvider
};

export function listProviders(): ModelBackendProvider[] {
	return Object.values(providers);
}

export function getProvider(id: string | null | undefined): ModelBackendProvider {
	return providers[normalizeBackendProvider(id)];
}

export function getDefaultProviderId(): BackendProviderId {
	return normalizeBackendProvider(loadConfig().DEFAULT_BACKEND_PROVIDER);
}

export function getDefaultProvider(): ModelBackendProvider {
	return getProvider(getDefaultProviderId());
}

export async function fetchAuthStatus(
	userId: string,
	providerAuthToken?: string,
	provider: BackendProviderId = getDefaultProviderId()
): Promise<ProviderAuthStatus> {
	return getProvider(provider).fetchAuthStatus(userId, providerAuthToken);
}

export async function fetchModels(
	userId: string,
	providerAuthToken?: string,
	provider: BackendProviderId = getDefaultProviderId()
): Promise<ProviderModelInfo[]> {
	return getProvider(provider).listModels(userId, providerAuthToken);
}

export async function open(opts: ProviderOpenOptions): Promise<ProviderSession> {
	return getProvider(opts.provider).openSession(opts);
}

export async function shutdownProviders(): Promise<void> {
	await Promise.all(listProviders().map((provider) => provider.shutdown?.()));
}
