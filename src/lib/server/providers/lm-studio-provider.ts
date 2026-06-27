import { loadConfig } from '../config';
import { log } from '../log';
import { fetchWithTimeout, jsonRequestHeaders, parseJson } from './provider-utils';
import {
	openAICompatibleSamplingOptions,
	openOpenAICompatibleSession,
	type OpenAICompatibleConfig
} from './openai-compatible-provider';
import type { BackendProviderId } from '$lib/types';
import type {
	ModelBackendProvider,
	ProviderAuthStatus,
	ProviderModelInfo,
	ProviderOpenOptions,
	ProviderSession
} from './provider';

interface LMStudioConfig {
	id: Extract<BackendProviderId, 'lm-studio'>;
	displayName: string;
	nativeBaseUrl: string;
	openAIBaseUrl: string;
	apiKey: string | null;
	maxToolIterations: number;
	contextRestoreMessages: number;
	sampling: OpenAICompatibleConfig['sampling'];
}

interface LMStudioModel {
	type?: string;
	key?: string;
	display_name?: string;
	max_context_length?: number;
	loaded_instances?: Array<{ id?: string; config?: { context_length?: number } }>;
	variants?: string[];
	selected_variant?: string;
}

interface ModelsResponse {
	models?: LMStudioModel[];
	error?: {
		message?: string;
	};
}

const providerId = 'lm-studio' satisfies Extract<BackendProviderId, 'lm-studio'>;
const displayName = 'LM Studio';
const MODEL_CONTEXT_CACHE_TTL_MS = 5 * 60_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
const modelContextCache = new Map<string, { at: number; contextLength: number }>();

export const lmStudioProvider: ModelBackendProvider = {
	id: providerId,
	displayName,
	ui: {
		chatPlaceholder: 'Message LM Studio...',
		defaultModelPlaceholder: 'publisher/model-name',
		setupHint:
			'Start the LM Studio local server. The portal uses LM Studio /v1 chat completions for stateless chats and /api/v1/models for model context metadata.',
		setupHintVisibility: 'always'
	},
	status: {
		probe: 'when-default',
		skippedStatusMessage: 'Not checked because LM Studio is not the default provider.'
	},
	capabilities: {
		authStatus: true,
		modelList: true,
		session: {
			open: true,
			resume: false,
			dispose: true,
			abort: true
		},
		stream: {
			send: true,
			contract: 'PortalEvent'
		},
		controls: {
			mode: false,
			approveAll: true,
			resetSessionApprovals: false
		},
		features: {
			modes: {
				supported: false,
				behavior: 'no-op',
				label: 'Runtime modes',
				description:
					'LM Studio OpenAI-compatible chats do not expose Copilot runtime modes. The saved mode is retained for portal permission semantics; it is not sent to LM Studio.'
			},
			approveAll: {
				supported: true,
				behavior: 'portal-enforced',
				label: 'Approve all',
				description:
					'Approve-all is enforced by the portal for portal-hosted tools. LM Studio does not receive a separate runtime approve-all signal.'
			},
			contextUsage: {
				supported: true,
				behavior: 'supported',
				label: 'Context usage',
				description:
					'LM Studio context usage is shown when streamed OpenAI-compatible usage is available; context limits come from native model metadata.'
			},
			subagents: {
				supported: false,
				behavior: 'unsupported',
				label: 'Subagents',
				description: 'The Copilot subagent/task runtime is unavailable in LM Studio sessions.'
			},
			mcpInfoEvents: {
				supported: false,
				behavior: 'unsupported',
				label: 'MCP info events',
				description:
					'MCP sampling, OAuth, and external-tool info events are Copilot SDK events and are not emitted by LM Studio OpenAI-compatible sessions.'
			},
			planExit: {
				supported: false,
				behavior: 'unsupported',
				label: 'Plan exit',
				description:
					'LM Studio OpenAI-compatible sessions do not support Copilot plan-exit callbacks.'
			},
			elicitation: {
				supported: false,
				behavior: 'unsupported',
				label: 'Elicitation',
				description:
					'LM Studio OpenAI-compatible sessions do not support Copilot elicitation callbacks.'
			}
		},
		optionalRuntimeFeatures: {
			infiniteSessionMetadata: false,
			permissionCallbacks: true,
			userInputCallbacks: false,
			elicitationCallbacks: false,
			exitPlanModeCallbacks: false,
			autoModeSwitchCallbacks: false,
			contextWindowEvents: true,
			contextCompactionEvents: false,
			fileEditEvents: false,
			reasoningEvents: false,
			subagentLifecycleEvents: false
		}
	},
	async fetchAuthStatus(): Promise<ProviderAuthStatus> {
		const cfg = providerConfig();
		try {
			const res = await fetchWithTimeout(
				nativeEndpoint(cfg.nativeBaseUrl, '/models'),
				{
					headers: requestHeaders(cfg)
				},
				MODEL_DISCOVERY_TIMEOUT_MS
			);
			if (res.ok) {
				return {
					isAuthenticated: true,
					authType: cfg.apiKey ? 'api-token' : 'none',
					statusMessage: cfg.nativeBaseUrl
				};
			}
			return {
				isAuthenticated: false,
				...(cfg.apiKey ? { authType: 'api-token' } : {}),
				statusMessage: `${displayName} returned ${res.status}: ${res.statusText}`
			};
		} catch (e) {
			return {
				isAuthenticated: false,
				statusMessage: backendErrorMessage(cfg, e)
			};
		}
	},
	async listModels(): Promise<ProviderModelInfo[]> {
		const cfg = providerConfig();
		try {
			const res = await fetchWithTimeout(
				nativeEndpoint(cfg.nativeBaseUrl, '/models'),
				{
					headers: requestHeaders(cfg)
				},
				MODEL_DISCOVERY_TIMEOUT_MS
			);
			const body = (await parseJson(res)) as ModelsResponse;
			if (!res.ok) {
				log.warn('lm_studio.models_failed', {
					status: res.status,
					err: body.error?.message ?? res.statusText
				});
				return [];
			}
			return (body.models ?? [])
				.filter((model) => model.type === 'llm' && typeof model.key === 'string')
				.map((model) => {
					const loadedId = model.loaded_instances?.find((instance) => instance.id)?.id;
					const maxContext =
						model.loaded_instances?.find((instance) => instance.config?.context_length)?.config
							?.context_length ?? model.max_context_length;
					return {
						id: loadedId ?? model.key!,
						name: model.display_name ?? model.key!,
						...(typeof maxContext === 'number'
							? { capabilities: { limits: { max_context_window_tokens: maxContext } } }
							: {})
					};
				});
		} catch (e) {
			log.warn('lm_studio.models_failed', { err: String(e) });
			return [];
		}
	},
	async openSession(opts: ProviderOpenOptions): Promise<ProviderSession> {
		const cfg = providerConfig();
		const tokenLimit = await fetchModelContextLength(cfg, opts.model);
		const sessionCfg: OpenAICompatibleConfig = {
			id: cfg.id,
			displayName: cfg.displayName,
			baseUrl: cfg.openAIBaseUrl,
			apiKey: cfg.apiKey,
			maxToolIterations: cfg.maxToolIterations,
			contextRestoreMessages: cfg.contextRestoreMessages,
			sampling: cfg.sampling,
			contextTokenLimit: tokenLimit,
			includeUsage: tokenLimit !== null
		};
		return openOpenAICompatibleSession(sessionCfg, opts);
	}
};

function providerConfig(): LMStudioConfig {
	const cfg = loadConfig();
	return {
		id: providerId,
		displayName,
		nativeBaseUrl: cfg.LMSTUDIO_BASE_URL,
		openAIBaseUrl: openAIEndpointBase(cfg.LMSTUDIO_BASE_URL),
		apiKey: cfg.LMSTUDIO_API_KEY ?? null,
		maxToolIterations: cfg.OPENAI_COMPATIBLE_MAX_TOOL_ITERATIONS,
		contextRestoreMessages: cfg.OPENAI_COMPATIBLE_CONTEXT_RESTORE_MESSAGES,
		sampling: openAICompatibleSamplingOptions(cfg)
	};
}

function requestHeaders(cfg: Pick<LMStudioConfig, 'apiKey'>): HeadersInit {
	return jsonRequestHeaders(cfg.apiKey);
}

function nativeEndpoint(baseUrl: string, path: string): string {
	const base = baseUrl.replace(/\/+$/, '');
	return `${base.endsWith('/api/v1') ? base : `${base}/api/v1`}${path}`;
}

function openAIEndpointBase(baseUrl: string): string {
	const base = baseUrl.replace(/\/+$/, '');
	if (base.endsWith('/v1') && !base.endsWith('/api/v1')) return base;
	if (base.endsWith('/api/v1')) return `${base.slice(0, -'/api/v1'.length)}/v1`;
	return `${base}/v1`;
}

async function fetchModelContextLength(
	cfg: LMStudioConfig,
	modelId: string
): Promise<number | null> {
	const cacheKey = `${cfg.nativeBaseUrl}\0${modelId}`;
	const cached = modelContextCache.get(cacheKey);
	if (cached && Date.now() - cached.at < MODEL_CONTEXT_CACHE_TTL_MS) {
		return cached.contextLength;
	}
	try {
		const res = await fetchWithTimeout(
			nativeEndpoint(cfg.nativeBaseUrl, '/models'),
			{
				headers: requestHeaders(cfg)
			},
			MODEL_DISCOVERY_TIMEOUT_MS
		);
		const body = (await parseJson(res)) as ModelsResponse;
		if (!res.ok) return null;
		const model = (body.models ?? []).find((candidate) => matchesModel(candidate, modelId));
		if (!model) return null;
		const exactLoadedContext = model.loaded_instances?.find((instance) => instance.id === modelId)
			?.config?.context_length;
		if (typeof exactLoadedContext === 'number') {
			modelContextCache.set(cacheKey, { at: Date.now(), contextLength: exactLoadedContext });
			return exactLoadedContext;
		}
		const firstLoadedContext = model.loaded_instances?.find(
			(instance) => instance.config?.context_length
		)?.config?.context_length;
		if (typeof firstLoadedContext === 'number') {
			modelContextCache.set(cacheKey, { at: Date.now(), contextLength: firstLoadedContext });
			return firstLoadedContext;
		}
		const contextLength =
			typeof model.max_context_length === 'number' ? model.max_context_length : null;
		if (contextLength !== null) {
			modelContextCache.set(cacheKey, { at: Date.now(), contextLength });
		}
		return contextLength;
	} catch (e) {
		log.warn('lm_studio.context_length_lookup_failed', { modelId, err: String(e) });
		return null;
	}
}

function matchesModel(model: LMStudioModel, modelId: string): boolean {
	return (
		model.type === 'llm' &&
		(model.key === modelId ||
			model.selected_variant === modelId ||
			model.variants?.includes(modelId) === true ||
			model.loaded_instances?.some((instance) => instance.id === modelId) === true)
	);
}

function backendErrorMessage(cfg: LMStudioConfig, e: unknown): string {
	if (e instanceof TypeError) {
		return `Unable to connect to ${cfg.displayName} backend at ${cfg.nativeBaseUrl}. Check that the LM Studio server is running and LMSTUDIO_BASE_URL points at it.`;
	}
	return e instanceof Error ? e.message : String(e);
}
