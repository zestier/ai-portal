import type { BackendProviderId, ProviderCapabilities } from '$lib/types';
import type {
	ModelBackendProvider,
	ProviderAuthStatus,
	ProviderModelInfo,
	ProviderUiInfo
} from './provider';

export type ProviderStatusSnapshot = {
	id: BackendProviderId;
	displayName: string;
	ui: ProviderUiInfo;
	auth: {
		isAuthenticated: boolean;
		authType?: string | undefined;
		login?: string | undefined;
		statusMessage?: string | undefined;
	};
	models: { id: string; name: string; maxContextWindowTokens?: number | undefined }[];
	capabilities: ProviderCapabilities;
	statusChecked: boolean;
	error?: string;
};

export type ProviderStatusLoader = {
	fetchAuthStatus(
		userId: string,
		providerAuthToken: string | undefined,
		provider: BackendProviderId
	): Promise<ProviderAuthStatus>;
	fetchModels(
		userId: string,
		providerAuthToken: string | undefined,
		provider: BackendProviderId
	): Promise<ProviderModelInfo[]>;
};

export function shouldProbeProviderStatus(
	provider: ModelBackendProvider,
	defaultProvider: BackendProviderId
): boolean {
	return provider.status.probe === 'always' || provider.id === defaultProvider;
}

export async function loadProviderStatus(
	provider: ModelBackendProvider,
	opts: {
		userId: string;
		providerAuthToken?: string;
		defaultProvider: BackendProviderId;
		loader: ProviderStatusLoader;
	}
): Promise<ProviderStatusSnapshot> {
	if (!shouldProbeProviderStatus(provider, opts.defaultProvider)) {
		return {
			id: provider.id,
			displayName: provider.displayName,
			ui: provider.ui,
			auth: {
				isAuthenticated: false,
				statusMessage:
					provider.status.skippedStatusMessage ??
					`Not checked because ${provider.displayName} is not the default provider.`
			},
			models: [],
			capabilities: provider.capabilities,
			statusChecked: false
		};
	}

	const [auth, models] = await Promise.all([
		opts.loader.fetchAuthStatus(opts.userId, opts.providerAuthToken, provider.id),
		opts.loader.fetchModels(opts.userId, opts.providerAuthToken, provider.id)
	]);
	return {
		id: provider.id,
		displayName: provider.displayName,
		ui: provider.ui,
		auth: {
			isAuthenticated: auth.isAuthenticated,
			authType: auth.authType,
			login: auth.login,
			statusMessage: auth.statusMessage
		},
		models: models.map((m) => ({
			id: m.id,
			name: m.name,
			maxContextWindowTokens: m.capabilities?.limits?.max_context_window_tokens
		})),
		capabilities: provider.capabilities,
		statusChecked: true
	};
}
