import type {
	BackendProviderId,
	PortalEvent,
	PermissionPolicy,
	ProviderCapabilities,
	MemoryMode,
	SessionMode,
	MessageStatus,
	Role,
	ToolCallRecord
} from '$lib/types';

export type { ProviderCapabilities } from '$lib/types';

export interface ProviderAuthStatus {
	isAuthenticated: boolean;
	authType?: string;
	login?: string;
	statusMessage?: string;
}

export interface ProviderModelInfo {
	id: string;
	name: string;
	capabilities?: {
		limits?: {
			max_context_window_tokens?: number;
		};
	};
}

export interface ProviderUiInfo {
	chatPlaceholder: string;
	defaultModelPlaceholder: string;
	setupHint?: string;
	setupHintVisibility?: 'always' | 'when-unauthenticated';
}

export interface ProviderStatusBehavior {
	probe: 'always' | 'when-default';
	skippedStatusMessage?: string;
}

export interface ProviderOpenOptions {
	provider?: BackendProviderId;
	conversationId: string;
	providerSessionId?: string;
	userId: string;
	workingDirectory: string;
	model: string;
	policy: PermissionPolicy;
	/** Initial session mode. Providers without mode support may ignore it. */
	mode?: SessionMode;
	/** Initial approve-all setting. Providers without approve-all support may ignore it. */
	approveAllTools?: boolean;
	/** Portal-managed memory mode. Providers use it to expose memory tools. */
	memoryMode?: MemoryMode;
	/** Explicit opt-in for user-scoped global memory tools. */
	globalMemoryEnabled?: boolean;
	/** Provider-specific bearer credential resolved by the route layer, if needed. */
	providerAuthToken?: string;
	/**
	 * Persisted conversation prefix for providers without durable resume. The
	 * runtime passes only messages before the current user prompt, so providers
	 * can hydrate fresh sessions without seeing portal database ids.
	 */
	initialMessages?: ProviderConversationMessage[];
	/**
	 * Called when a provider rotates or discovers a durable backend session id.
	 * The route/runtime layer owns persistence; provider implementations should
	 * not write portal conversation rows directly. If this callback rejects, the
	 * provider must treat the id as uncommitted and fail the current turn rather
	 * than continuing with backend state the portal cannot resume.
	 */
	onProviderSessionIdChange?: (providerSessionId: string) => void | Promise<void>;
	onEvent?: (e: PortalEvent) => void;
}

export interface ProviderConversationMessage {
	role: Role;
	content: string;
	status: MessageStatus;
	toolCalls?: ToolCallRecord[];
}

export interface ProviderSession {
	provider?: BackendProviderId;
	conversationId: string;
	providerSessionId: string;
	workingDirectory: string;
	model: string;
	lastUsed: number;
	send(prompt: string, signal: AbortSignal): AsyncIterable<PortalEvent>;
	abort(): Promise<void>;
	dispose(): Promise<void>;
	/** Optional live mode control. Persisting settings is caller-owned. */
	setMode?(mode: SessionMode): Promise<void>;
	/** Optional live approve-all control. Persisting settings is caller-owned. */
	setApproveAll?(enabled: boolean): Promise<void>;
	/** Optional provider/session-scoped approval cache reset. */
	resetSessionApprovals?(): Promise<void>;
}

export interface ModelBackendProvider {
	id: BackendProviderId;
	displayName: string;
	ui: ProviderUiInfo;
	status: ProviderStatusBehavior;
	capabilities: ProviderCapabilities;
	resolveAuthToken?(userId: string): string | undefined;
	fetchAuthStatus(userId: string, providerAuthToken?: string): Promise<ProviderAuthStatus>;
	listModels(userId: string, providerAuthToken?: string): Promise<ProviderModelInfo[]>;
	/**
	 * Open a conversation session. Providers that support resume should resume
	 * by `conversationId`; providers that do not should open a fresh backend
	 * session while keeping the portal conversation durable in SQLite.
	 */
	openSession(opts: ProviderOpenOptions): Promise<ProviderSession>;
	/**
	 * Providers with durable resume but no request-time assistant-history import
	 * can ask the portal to wrap prior messages into the next prompt until a
	 * backend-native session id exists.
	 */
	shouldEmbedPriorMessages?(providerSessionId: string): boolean;
	shutdown?(): Promise<void>;
}
