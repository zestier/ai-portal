import type {
	ApprovalMode,
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
	/** Instance id of the backend serving this conversation (see `ProviderInstance`). */
	provider?: string;
	conversationId: string;
	providerSessionId?: string;
	userId: string;
	workingDirectory: string;
	/** Stable logical repository identity used to scope tickets across worktrees. */
	workspaceKey?: string;
	model: string;
	policy: PermissionPolicy;
	/** Initial session mode. Providers without mode support may ignore it. */
	mode?: SessionMode;
	/**
	 * Initial approval mode. `ask` and `auto-deny` are enforced portal-side by
	 * the interactive adapter; providers only need to mirror `auto-approve`
	 * into their runtime when they can (see `controls.approvalMode`).
	 */
	approvalMode?: ApprovalMode;
	/**
	 * The conversation's adversary (shadow reviewer) model, if it has one.
	 * Captured at session open like `approvalMode`; unlike approval mode it has
	 * no live setter, because it only configures a measurement and a change can
	 * wait for the next session — matching `memoryExtractorModel` semantics.
	 */
	adversaryModel?: string | null;
	/**
	 * The backend that should serve the adversary reviewer. Null/undefined means
	 * "fall back to `ADVERSARY_SHADOW_BACKEND`, then to this conversation's own
	 * backend" — the fallback that lets a single-backend deployment run the
	 * shadow at all.
	 */
	adversaryBackend?: string | null;
	/**
	 * Portal tool groups disabled for this conversation. Providers drop the
	 * matching tool group from the assembled portal tools. Empty/undefined =
	 * all groups enabled.
	 */
	disabledToolGroups?: string[];
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
	/** Instance id of the backend serving this session. */
	provider?: string;
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
	/** Optional live approval-mode control. Persisting settings is caller-owned. */
	setApprovalMode?(mode: ApprovalMode): Promise<void>;
	/** Optional provider/session-scoped approval cache reset. */
	resetSessionApprovals?(): Promise<void>;
}

/**
 * A one-shot completion request served outside any conversation session.
 *
 * Intentionally minimal — no tools, no history, no streaming. It carries only
 * what a stateless reviewer-style call needs, so every backend can satisfy it
 * without exposing session machinery.
 */
export interface ProviderCompletionRequest {
	/** Model id in the TARGET provider's namespace, not the chat model's. */
	model: string;
	system: string;
	user: string;
	/**
	 * Optional JSON-schema hint. Backends that can enforce structured output
	 * (OpenAI-compatible `response_format`) should; those that cannot must
	 * ignore it rather than fail, since callers parse defensively anyway.
	 */
	responseSchema?: { name: string; schema: unknown } | undefined;
	timeoutMs: number;
	/**
	 * Identity for backends whose auth and model entitlements are per-user
	 * (Copilot). Backends configured with a single operator-level credential
	 * ignore both.
	 */
	userId?: string | undefined;
	providerAuthToken?: string | undefined;
	signal?: AbortSignal | undefined;
}

export interface ModelBackendProvider {
	/** Instance id. Built-in instances use their type id; extra instances use their configured id. */
	id: string;
	/** The implementation type. */
	type: BackendProviderId;
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
	 * Best-effort re-warm ("prime") of a model on a local load/unload backend
	 * (Ollama via openai-compatible, LM Studio). Called after background work
	 * — the model-backed memory extractor — has loaded a *different* model and
	 * evicted the main chat model, so the next user turn avoids a cold-load
	 * stall. Implementations issue a minimal warmup request bounded by `signal`.
	 * Fire-and-forget: the caller never blocks on it and swallows failures, so
	 * implementations may reject on error. Absent (or a no-op) for providers
	 * whose `capabilities.localModelLoad.primeAfterModelSwap` is false, e.g.
	 * cloud backends with no local load/unload.
	 */
	primeModel?(model: string, opts: { signal: AbortSignal }): Promise<void>;
	/**
	 * One-shot, tool-less completion outside any conversation session. Returns
	 * the model's raw text; callers own parsing.
	 *
	 * Same shape as `primeModel` — optional, out-of-band, per-provider — and
	 * present exactly when `capabilities.sideCompletion` is true. It exists so
	 * background reviewers can run on the conversation's own backend instead of
	 * requiring a separate endpoint.
	 *
	 * Deliberately tool-less: a reviewer with tools would recurse the very
	 * permission problem it is reviewing (who approves the reviewer's tool
	 * calls?). Implementations must not expose portal tools, and must not write
	 * conversation state.
	 *
	 * Rejects on transport failure, timeout, or a non-OK response. Callers are
	 * expected to treat a rejection as "no answer" rather than a verdict.
	 */
	complete?(req: ProviderCompletionRequest): Promise<string>;
	/**
	 * Providers with durable resume but no request-time assistant-history import
	 * can ask the portal to wrap prior messages into the next prompt until a
	 * backend-native session id exists.
	 */
	shouldEmbedPriorMessages?(providerSessionId: string): boolean;
	shutdown?(): Promise<void>;
}
