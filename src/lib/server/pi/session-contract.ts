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
	conversationId: number;
	providerSessionId?: string;
	userId: number;
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
	/**
	 * Optional system-prompt override seeded from the launching prompt template
	 * (pi ResourceLoader `systemPrompt`). Absent = default coding identity.
	 */
	systemPrompt?: string;
	/** Optional system-prompt suffix from the launching prompt template. */
	appendSystemPrompt?: string;
	/** Portal-managed memory mode. */
	memoryMode?: MemoryMode;
	/** Explicit opt-in for user-scoped global memory tools. */
	globalMemoryEnabled?: boolean;
	/**
	 * Durable pi session file for this conversation, or `null` when the
	 * conversation has none yet (a fresh one is created and stored on the
	 * conversation row once the turn runs). `undefined` means "don't persist" —
	 * the session is in-memory only (one-shot opens, memory-mode turns).
	 */
	sessionFilePath?: string | null;
	/**
	 * 0-based index of the user message (among user messages, oldest first) the
	 * session should rewind to before sending the prompt — the edit/regenerate
	 * path. The pi tree rewinds so the prompt starts a new branch from that
	 * message's parent, matching the SQLite truncation. Absent for normal turns.
	 */
	rewindToUserMessageOrdinal?: number;
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
	conversationId: number;
	providerSessionId: string;
	workingDirectory: string;
	model: string;
	/**
	 * Absolute path to the durable pi session file backing this session, when
	 * one exists. Absent for in-memory sessions (one-shot opens, memory-mode).
	 * The runtime writes it back to the conversation row so later acquires
	 * resume the same tree.
	 */
	sessionFile?: string;
	/**
	 * sha1 over the operator-managed extension set this session was opened
	 * with (see `extensions.fingerprint`). The session pool re-matches on it:
	 * a change disposes+recreates the session on the next acquire.
	 */
	extensionFingerprint?: string;
	lastUsed: number;
	send(prompt: string, signal: AbortSignal): AsyncIterable<PortalEvent>;
	abort(): Promise<void>;
	dispose(): Promise<void>;
	/**
	 * Rewind the session tree to the given user-message ordinal (0-based among
	 * user messages on the active path) so the next `send` starts a fresh branch
	 * from that message's parent — the edit/regenerate semantics. Sessions that
	 * cannot rewind (in-memory, no tree) leave the implementation to no-op.
	 */
	rewindToUserMessageOrdinal?(ordinal: number): Promise<void>;
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
	userId?: number | undefined;
	signal?: AbortSignal | undefined;
}
