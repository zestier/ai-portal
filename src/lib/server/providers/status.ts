import type { BackendProviderId, ProviderCapabilities } from '$lib/types';
import type {
	ModelBackendProvider,
	ProviderAuthStatus,
	ProviderModelInfo,
	ProviderUiInfo
} from './provider';

export type ProviderStatusSnapshot = {
	id: string;
	type: BackendProviderId;
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
		provider: string
	): Promise<ProviderAuthStatus>;
	fetchModels(
		userId: string,
		providerAuthToken: string | undefined,
		provider: string
	): Promise<ProviderModelInfo[]>;
};

export function shouldProbeProviderStatus(
	provider: ModelBackendProvider,
	defaultProvider: string
): boolean {
	return provider.status.probe === 'always' || provider.id === defaultProvider;
}

export async function loadProviderStatus(
	provider: ModelBackendProvider,
	opts: {
		userId: string;
		providerAuthToken?: string;
		defaultProvider: string;
		loader: ProviderStatusLoader;
	}
): Promise<ProviderStatusSnapshot> {
	if (!shouldProbeProviderStatus(provider, opts.defaultProvider)) {
		return {
			id: provider.id,
			type: provider.type,
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

	const [authResult, modelsResult] = await Promise.allSettled([
		opts.loader.fetchAuthStatus(opts.userId, opts.providerAuthToken, provider.id),
		opts.loader.fetchModels(opts.userId, opts.providerAuthToken, provider.id)
	]);
	// Resolve each leg independently: a transient model-list failure must not
	// discard a successful auth probe (and vice versa), which would otherwise
	// paint the provider fully unavailable on the settings page. Fall back to an
	// unauthenticated/empty result for whichever leg rejected, and surface the
	// failure(s) via the optional `error` field rather than throwing.
	const auth: ProviderAuthStatus =
		authResult.status === 'fulfilled' ? authResult.value : { isAuthenticated: false };
	const models: ProviderModelInfo[] = modelsResult.status === 'fulfilled' ? modelsResult.value : [];
	const errors: string[] = [];
	if (authResult.status === 'rejected') errors.push(`auth: ${reason(authResult.reason)}`);
	if (modelsResult.status === 'rejected') errors.push(`models: ${reason(modelsResult.reason)}`);
	return {
		id: provider.id,
		type: provider.type,
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
		statusChecked: true,
		...(errors.length ? { error: errors.join('; ') } : {})
	};
}

function reason(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
