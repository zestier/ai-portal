// The session contract between the runtime and the pi SDK session wrapper.
//
// Re-homed here when the backend-provider layer was deleted: pi is the only
// session owner left, and these are the types the turn-runner / session pool /
// turn-start / background-reviewer consumers still rely on.

import type {
	ApprovalMode,
	MemoryMode,
	PermissionPolicy,
	PortalEvent,
	Role,
	SessionMode,
	MessageStatus,
	ToolCallRecord
} from '$lib/types';

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
	/** Instance id of the backend serving this conversation. */
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
	 * Initial approval mode. `ask` and `auto-deny` are enforced portal-side; only
	 * `auto-approve` is mirrored into the runtime when it can.
	 */
	approvalMode?: ApprovalMode;
	/** Portal tool groups disabled for this conversation. */
	disabledToolGroups?: string[];
	/** Portal-managed memory mode. */
	memoryMode?: MemoryMode;
	/** Explicit opt-in for user-scoped global memory tools. */
	globalMemoryEnabled?: boolean;
	/**
	 * Persisted conversation prefix for providers without durable resume. The
	 * runtime passes only messages before the current user prompt, so providers
	 * can hydrate fresh sessions without seeing portal database ids.
	 */
	initialMessages?: ProviderConversationMessage[];
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
 * what a stateless reviewer-style call needs.
 */
export interface ProviderCompletionRequest {
	/** Model id in the TARGET provider's namespace, not the chat model's. */
	model: string;
	system: string;
	user: string;
	/**
	 * Optional JSON-schema hint. Backends that can enforce structured output
	 * should; those that cannot must ignore it rather than fail, since callers
	 * parse defensively anyway.
	 */
	responseSchema?: { name: string; schema: unknown } | undefined;
	timeoutMs: number;
	userId?: string | undefined;
	signal?: AbortSignal | undefined;
}
