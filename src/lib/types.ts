// Shared types used by both client and server.

import type { GrantScope } from './permissions/scope-types';

export type Role = 'user' | 'assistant' | 'system';
export type MessageStatus = 'complete' | 'streaming' | 'interrupted' | 'error';

export interface User {
	id: string;
	githubLogin: string;
	displayName: string | null;
	avatarUrl: string | null;
}

export interface Conversation {
	id: string;
	userId: string;
	title: string;
	workdir: string;
	provider: BackendProviderId;
	model: string | null;
	/**
	 * Agent mode for this conversation. Mostly mirrors the SDK's
	 * `SessionMode`, with one portal-only extension:
	 *   - `interactive` (default): regular chat; the agent prompts for
	 *     permission and can call tools freely.
	 *   - `plan`: the agent plans without executing destructive tools and
	 *     surfaces an `exit_plan_mode` request before switching to execute.
	 *   - `autopilot`: less-supervised mode hint — the agent is expected to
	 *     work for long stretches with minimal user interaction.
	 *   - `best-effort`: forwarded to the runtime as `autopilot`, but the
	 *     portal auto-rejects prompt-worthy permission requests with
	 *     feedback instead of asking the user.
	 *
	 * The mode is forwarded to the runtime each time the session is opened.
	 */
	mode: SessionMode;
	/**
	 * Optional portal-managed durable memory profile. When enabled, the
	 * server starts each request from a fresh provider context assembled
	 * from typed memory plus memory tools.
	 */
	memoryMode: MemoryMode;
	/**
	 * Optional per-conversation override for the model-backed memory harvester.
	 * Null means "use the server default extractor model/config".
	 */
	memoryExtractorModel: string | null;
	/**
	 * Explicit opt-in for user-scoped global memory tools in this conversation.
	 * Session memory remains per-conversation even when this is false.
	 */
	globalMemoryEnabled: boolean;
	/**
	 * Per-conversation bypass: when true, every tool-permission request is
	 * auto-approved (an `auto-allow` audit row is still written). The flag
	 * is also mirrored to the SDK via `permissions.setApproveAll` so the
	 * model knows it's running in a less-supervised context.
	 */
	approveAllTools: boolean;
	createdAt: number;
	updatedAt: number;
	archivedAt: number | null;
	/** Set when this conversation was created by forking another one. */
	forkedFromConversationId: string | null;
	/** The message in the source conversation whose edit produced this fork. */
	forkedFromMessageId: string | null;
	/** Backend runtime session id. May rotate when a conversation is destructively rewritten. */
	providerSessionId: string;
}

export type WorkspaceTicketStatus = 'open' | 'done' | 'archived';

export interface WorkspaceTicket {
	id: string;
	userId: string;
	workspaceKey: string;
	title: string;
	body: string;
	status: WorkspaceTicketStatus;
	sourceConversationId: string | null;
	sourceMessageId: string | null;
	createdAt: number;
	updatedAt: number;
	closedAt: number | null;
}

export type PromptTemplateStatus = 'open' | 'archived';

export interface ChatPromptTemplate {
	id: string;
	/** Built-in templates are static and not owned by a user. */
	userId: string | null;
	title: string;
	description: string;
	prompt: string;
	status: PromptTemplateStatus;
	pinned: boolean;
	orderIndex: number;
	createdAt: number;
	updatedAt: number;
	archivedAt: number | null;
}

// Portal session modes. `best-effort` is the only portal-only extension; it
// maps to the runtime's `autopilot` mode while keeping stricter permission
// semantics in the bridge.
export type SessionMode = 'interactive' | 'plan' | 'autopilot' | 'best-effort';

export function normalizeSessionMode(raw: string | null | undefined): SessionMode {
	return raw === 'plan' || raw === 'autopilot' || raw === 'best-effort' ? raw : 'interactive';
}

export type MemoryMode = 'off' | 'lightweight' | 'project' | 'story' | 'strict';

export function normalizeMemoryMode(raw: string | null | undefined): MemoryMode {
	return raw === 'lightweight' || raw === 'project' || raw === 'story' || raw === 'strict'
		? raw
		: 'off';
}

export const BACKEND_PROVIDER_IDS = ['copilot', 'openai-compatible', 'lm-studio'] as const;
export type BackendProviderId = (typeof BACKEND_PROVIDER_IDS)[number];

export function normalizeBackendProvider(raw: string | null | undefined): BackendProviderId {
	return BACKEND_PROVIDER_IDS.includes(raw as BackendProviderId)
		? (raw as BackendProviderId)
		: 'copilot';
}

export type ProviderRuntimeFeature =
	| 'modes'
	| 'approveAll'
	| 'contextUsage'
	| 'subagents'
	| 'mcpInfoEvents'
	| 'planExit'
	| 'elicitation';

export type ProviderRuntimeFeatureBehavior =
	| 'supported'
	| 'portal-enforced'
	| 'no-op'
	| 'unsupported';

export interface ProviderRuntimeFeatureStatus {
	supported: boolean;
	behavior: ProviderRuntimeFeatureBehavior;
	label: string;
	description: string;
}

export type ProviderRuntimeFeatureMap = Record<
	ProviderRuntimeFeature,
	ProviderRuntimeFeatureStatus
>;

export interface ProviderCapabilities {
	authStatus: boolean;
	modelList: boolean;
	session: {
		open: true;
		/** Resume by conversation id when the provider has durable session state. */
		resume: boolean;
		dispose: true;
		abort: boolean;
	};
	stream: {
		send: true;
		/**
		 * Providers must normalize their native streaming protocol into PortalEvent.
		 * turn-runner consumes only this contract and should not depend on SDK-
		 * specific event shapes.
		 */
		contract: 'PortalEvent';
	};
	controls: {
		/** Supports live runtime modes such as plan/autopilot/best-effort. */
		mode: boolean;
		/** Supports live approve-all toggling for tool permission requests. */
		approveAll: boolean;
		/** Supports clearing provider/session-scoped approval grants. */
		resetSessionApprovals: boolean;
	};
	/**
	 * User-facing runtime capability contract. Providers must mark unsupported
	 * runtime features explicitly so API clients and UI copy do not imply
	 * unavailable behavior is active.
	 */
	features: ProviderRuntimeFeatureMap;
	/**
	 * Optional event families the portal can consume when present. Providers may
	 * leave these false and still satisfy the core PortalEvent stream contract.
	 */
	optionalRuntimeFeatures: {
		infiniteSessionMetadata: boolean;
		permissionCallbacks: boolean;
		userInputCallbacks: boolean;
		elicitationCallbacks: boolean;
		exitPlanModeCallbacks: boolean;
		autoModeSwitchCallbacks: boolean;
		contextWindowEvents: boolean;
		contextCompactionEvents: boolean;
		fileEditEvents: boolean;
		reasoningEvents: boolean;
		subagentLifecycleEvents: boolean;
	};
}

export interface Message {
	id: string;
	conversationId: string;
	role: Role;
	content: string;
	status: MessageStatus;
	errorCode: string | null;
	createdAt: number;
	toolCalls?: ToolCallRecord[];
	fileEdits?: FileEditRecord[];
	// Ordered assistant reasoning segments ("thinking") interleaved with
	// content. Each segment is one contiguous burst of reasoning deltas
	// anchored to a text offset, with its own elapsed-time window. Only
	// populated for models that emit reasoning.
	reasoningBlocks?: ReasoningBlockRecord[];
}

export interface ReasoningBlockRecord {
	id: string;
	messageId: string;
	segmentIndex: number;
	text: string;
	// Where this segment appeared within the assistant's accumulated content
	// (mirrors ToolCallRecord.textOffset). NULL = legacy / unknown / child
	// of a sub-agent (not anchored to the outer assistant's text).
	textOffset: number | null;
	startedAt: number;
	durationMs: number | null;
	// When set, this block was emitted by a sub-agent spawned by the outer
	// `task` tool call with this id. Such blocks are rendered inside the
	// SubagentCall component, not at the message level.
	parentToolCallId: string | null;
}

export interface ToolCallRecord {
	id: string;
	messageId: string;
	tool: string;
	argsJson: string;
	resultJson: string | null;
	status: 'pending' | 'ok' | 'error' | 'denied';
	startedAt: number;
	endedAt: number | null;
	textOffset: number | null;
	// See ReasoningBlockRecord.parentToolCallId. Sub-agents can in turn
	// invoke their own tools; those nested calls are children of the
	// outermost `task` tool call.
	parentToolCallId: string | null;
	// For background `task` calls, these fields track the spawned agent's
	// lifecycle separately from the launch tool-call status.
	backgroundAgentStatus?: 'running' | 'completed' | 'failed' | null;
	backgroundAgentId?: string | null;
	backgroundAgentStartedAt?: number | null;
	backgroundAgentEndedAt?: number | null;
	// Ephemeral live-streaming state. Populated client-side from
	// `tool.partial_output` and `tool.progress` events while the tool is
	// running. Not persisted: server-side rehydrations leave these unset.
	partialOutput?: string;
	progressMessage?: string;
}

export interface FileEditRecord {
	id: string;
	messageId: string;
	path: string;
	diff: string;
	createdAt: number;
	textOffset: number | null;
	// See ReasoningBlockRecord.parentToolCallId.
	parentToolCallId: string | null;
}

export interface UserSettings {
	defaultProvider: BackendProviderId;
	defaultModel: string | null;
	defaultWorkdir: string | null;
	defaultConversationMode: SessionMode;
	defaultPolicy: PermissionPolicy;
	theme: 'dark' | 'light' | 'system';
}

// 'prompt' is the default: auto-approves `url` requests and file-system
// requests (`read`, `write`, `edit`) whose target path resolves inside
// the conversation's working directory; everything else asks the user.
// 'allow-all' and 'deny-all' are escape hatches. A previous
// 'allow-readonly' value was dropped because it behaved identically to
// 'prompt'; migration 008 rewrites existing rows.
export type PermissionPolicy = 'prompt' | 'allow-all' | 'deny-all';

// --- Interactive requests ---
//
// The SDK can pause a turn to ask the host (us) for input: permission to run
// a tool, free-form text, structured form fields, approval to leave plan
// mode, etc. We normalize all of them into a single discriminated union so
// the UI has one event channel + one dialog component to switch on.

export type InteractiveKind =
	| 'permission'
	| 'auto_mode_switch'
	| 'user_input'
	| 'elicitation'
	| 'exit_plan_mode'
	// "info" kinds: the SDK fires these but does not expose a public
	// responder. We surface them so the user knows what's happening; the
	// turn proceeds whenever the SDK resolves the request on its own.
	| 'sampling'
	| 'mcp_oauth'
	| 'external_tool';

export interface InteractivePermissionView {
	kind: 'permission';
	tool: string;
	permissionKind: string;
	summary: string;
	args: unknown;
	/**
	 * The user's current default permission policy at the time the request
	 * was raised. Exposed so the dialog can disable / explain options that
	 * would otherwise be silently dropped (e.g. "Allow always" under
	 * `deny-all`, which `interactive-requests.ts` refuses to persist).
	 */
	userPolicy?: PermissionPolicy;
	/**
	 * False for sensitive one-shot permissions (for example switching a
	 * best-effort conversation back to interactive mode). The dialog must not
	 * offer persistent allow/deny actions, and the server rejects them.
	 */
	canPersistDecision?: boolean;
	/**
	 * Set when an otherwise auto-rejected request intentionally escalates to
	 * a human prompt after a feedback-bearing deny grant.
	 */
	escalationReason?: string;
	/**
	 * Initial text for the deny feedback field. Prompt-required grants use
	 * this to suggest the same feedback that would be sent on auto-deny.
	 */
	defaultDenyFeedback?: string;
	/**
	 * For `shell` permissions: the server-side parser's verdict on the
	 * command. `parsed` means we tokenized it into segments split on
	 * `&&`/`||`/`;`/`|`; the dialog uses this to break the pipeline out
	 * and offer per-argv0 grants. `unsafe` means the command contains
	 * constructs (subshells, redirection, var expansion, ...) we refused
	 * to model; structured grants can't apply, so the dialog warns the
	 * user and downgrades the grant picker. Omitted for non-shell kinds.
	 */
	shellAnalysis?: ShellAnalysisView;
}

export type ShellAnalysisView =
	| { kind: 'parsed'; segments: ShellAnalysisSegment[] }
	| { kind: 'unsafe'; reason: string };

export interface ShellAnalysisSegment {
	argv: string[];
	/** Operator that follows this segment in the pipeline. `null` on the
	 * final segment. Mirrors `ParsedSegment.followingOp` from the server
	 * parser. */
	followingOp: '&&' | '||' | ';' | '|' | null;
}

export interface InteractiveAutoModeSwitchView {
	kind: 'auto_mode_switch';
	errorCode?: string;
	retryAfterSeconds?: number;
}

export interface InteractiveUserInputView {
	kind: 'user_input';
	question: string;
	choices?: string[];
	allowFreeform: boolean;
}

export interface InteractiveElicitationView {
	kind: 'elicitation';
	message: string;
	mode: 'form' | 'url';
	url?: string;
	requestedSchema?: ElicitationSchema;
	elicitationSource?: string;
}

export interface InteractiveExitPlanModeView {
	kind: 'exit_plan_mode';
	summary: string;
	planContent?: string;
	actions: string[];
	recommendedAction: string;
}

export interface InteractiveSamplingView {
	kind: 'sampling';
	mcpServerName?: string;
	summary: string;
}

export interface InteractiveMcpOauthView {
	kind: 'mcp_oauth';
	mcpServerName?: string;
	authorizationUrl?: string;
	summary: string;
}

export interface InteractiveExternalToolView {
	kind: 'external_tool';
	toolName: string;
	summary: string;
}

export type InteractiveRequestViewBody =
	| InteractivePermissionView
	| InteractiveAutoModeSwitchView
	| InteractiveUserInputView
	| InteractiveElicitationView
	| InteractiveExitPlanModeView
	| InteractiveSamplingView
	| InteractiveMcpOauthView
	| InteractiveExternalToolView;

export type InteractiveRequestView = { requestId: string } & InteractiveRequestViewBody;

export type InteractiveResponse =
	| {
			kind: 'permission';
			decision: InteractivePermissionDecision;
			/** Optional narrow scope for *-always decisions. Omitted scope means
			 * "any kind, any args" (backwards-compatible with the original
			 * coarse "Allow always for this tool" grant). */
			scope?: PermissionGrantScope;
			/**
			 * Additional grants to persist alongside `scope` on *-always
			 * decisions. Used by the shell picker when the user checks
			 * multiple per-argv0 scopes for one pipeline (e.g. a pipeline
			 * `git status | rg foo` can persist "any `git`" and "any `rg`"
			 * in one click). Each entry is stored as its own grant row;
			 * the matcher ORs them at decision time.
			 */
			additionalScopes?: PermissionGrantScope[];
			/** Optional TTL for *-always decisions, in milliseconds. */
			expiresInMs?: number;
			/**
			 * When true, an *-always grant is stored user-global (matches the
			 * tool in every conversation). Default false → conversation-scoped.
			 */
			applyToAllConversations?: boolean;
			/** Optional agent-facing feedback for manual deny decisions. */
			feedback?: string;
	  }
	| { kind: 'auto_mode_switch'; decision: 'yes' | 'no' }
	| { kind: 'user_input'; answer: string; wasFreeform?: boolean }
	| {
			kind: 'elicitation';
			action: 'accept' | 'decline' | 'cancel';
			content?: Record<string, string | number | boolean | string[]>;
	  }
	| {
			kind: 'exit_plan_mode';
			approved: boolean;
			selectedAction?: string;
			feedback?: string;
	  }
	// "info" kinds: client can only acknowledge / dismiss. Always 'ack'.
	| { kind: 'sampling'; action: 'ack' }
	| { kind: 'mcp_oauth'; action: 'ack' }
	| { kind: 'external_tool'; action: 'ack' };

export interface PermissionGrantScope {
	/** NULL/omitted = any permission kind for the requested tool. */
	permissionKind?: string | null;
	/** Tiny glob (`*` matches any run). NULL/omitted = any scope. */
	pattern?: string | null;
	/** Structured grant scope. When set, the matcher uses this and
	 * ignores `pattern`. The dialog emits this for typed kinds (fs
	 * exact/prefix, etc.); legacy plain-pattern paths remain for shell
	 * and URL until they get their own structured pickers. */
	scope?: GrantScope;
}

export interface ElicitationSchema {
	type: 'object';
	properties: Record<string, ElicitationSchemaField>;
	required?: string[];
}

export type ElicitationSchemaField =
	| {
			type: 'string';
			title?: string;
			description?: string;
			enum?: string[];
			enumNames?: string[];
			minLength?: number;
			maxLength?: number;
			format?: 'email' | 'uri' | 'date' | 'date-time';
			default?: string;
	  }
	| {
			type: 'number' | 'integer';
			title?: string;
			description?: string;
			minimum?: number;
			maximum?: number;
			default?: number;
	  }
	| {
			type: 'boolean';
			title?: string;
			description?: string;
			default?: boolean;
	  }
	| {
			type: 'array';
			title?: string;
			description?: string;
			minItems?: number;
			maxItems?: number;
			items: { type: 'string'; enum?: string[] };
			default?: string[];
	  };

// --- Normalized streaming protocol (server -> client over SSE) ---

export type PortalEvent =
	| { type: 'message.start'; messageId: string; role: 'assistant' }
	| { type: 'message.delta'; messageId: string; text: string }
	| {
			type: 'message.reasoning';
			messageId: string;
			segmentId: string;
			text: string;
			// When set, this reasoning burst originated inside the sub-agent
			// spawned by the outer `task` tool call with this id.
			parentToolCallId?: string;
	  }
	| {
			type: 'message.reasoning.end';
			messageId: string;
			segmentId: string;
			durationMs: number;
			parentToolCallId?: string;
	  }
	| { type: 'message.end'; messageId: string }
	| {
			type: 'subagent.lifecycle';
			toolCallId: string;
			agentId: string;
			status: 'running' | 'completed' | 'failed';
	  }
	| {
			type: 'tool.call';
			toolCallId: string;
			tool: string;
			args: unknown;
			parentToolCallId?: string;
	  }
	| { type: 'interactive.request'; request: InteractiveRequestView }
	| {
			type: 'interactive.resolved';
			requestId: string;
			kind: InteractiveKind;
			// Free-form snapshot of the resolution for replay / audit. Specific
			// shape mirrors InteractiveResponse but is intentionally `unknown`
			// here so the SSE consumer can replay it without re-parsing.
			outcome: unknown;
			/**
			 * True when the resolution came from `cancel()` (turn-abort,
			 * timeout, server shutdown) rather than a user click. The outcome
			 * is still a default-denial so the SDK can move on, but the UI /
			 * audit log can distinguish the two cases.
			 */
			cancelled?: boolean;
			cancelReason?: string;
	  }
	| {
			type: 'tool.result';
			toolCallId: string;
			ok: boolean;
			summary: string;
			output?: unknown;
			parentToolCallId?: string;
	  }
	// Ephemeral live-streaming events from the SDK during a tool's execution.
	// Forwarded to subscribers but intentionally NOT appended to the turn's
	// event log: reconnects pick up the authoritative final state via
	// `tool.result` and don't need to replay stale partial chunks.
	| {
			type: 'tool.partial_output';
			toolCallId: string;
			output: string;
			parentToolCallId?: string;
	  }
	| {
			type: 'tool.progress';
			toolCallId: string;
			message: string;
			parentToolCallId?: string;
	  }
	| { type: 'file.edit'; path: string; diff: string; parentToolCallId?: string }
	| { type: 'conversation.update'; conversationId: string; title?: string }
	| {
			type: 'session.settings';
			conversationId: string;
			mode?: SessionMode;
			memoryMode?: MemoryMode;
			approveAllTools?: boolean;
			// Free-form source label so the UI can show "Agent switched to
			// plan mode" vs "You enabled autopilot" in a future iteration.
			source?: 'user' | 'agent' | 'system';
	  }
	| { type: 'reasoning.summary'; text: string }
	| {
			type: 'memory.status';
			conversationId: string;
			phase: 'checking' | 'extracting' | 'validating' | 'committed' | 'needs_review' | 'skipped';
			summary?: string;
			patchId?: string;
			counts?: {
				events?: number;
				facts?: number;
				decisions?: number;
				openLoops?: number;
				issues?: number;
			};
	  }
	| {
			type: 'context.usage';
			currentTokens: number;
			tokenLimit: number;
			messagesLength: number;
			systemTokens?: number;
			conversationTokens?: number;
			toolDefinitionsTokens?: number;
			isInitial?: boolean;
	  }
	| {
			type: 'context.compaction';
			phase: 'start' | 'complete';
			tokensRemoved?: number;
			messagesRemoved?: number;
	  }
	| { type: 'error'; code: string; message: string }
	| { type: 'heartbeat' }
	| { type: 'done' };

// Latest context-window snapshot persisted per conversation. Mirrors the
// shape of the `context.usage` PortalEvent (sans the `type` and `isInitial`
// transport fields) so the UI can seed its meter from page load.
export interface ConversationUsage {
	conversationId: string;
	currentTokens: number;
	tokenLimit: number;
	messagesLength: number;
	systemTokens: number | null;
	conversationTokens: number | null;
	toolDefinitionsTokens: number | null;
	updatedAt: number;
}

// Subset of `PermissionDecision` that the client can produce via the
// dialog. The `auto-*` values are server-only audit records.
export type InteractivePermissionDecision = 'allow-once' | 'allow-always' | 'deny' | 'deny-always';

// `auto-*` decisions are recorded by the server when the user's default policy
// or stored grants settled the request without a dialog. They never appear in
// `InteractiveResponse` — the dialog only ever surfaces the four interactive
// decisions — but they show up in the settings page audit so the user can see
// what got approved silently, hard-denied, or rejected because a prompt was
// required in best-effort mode.
export type PermissionDecision =
	| 'allow-once'
	| 'allow-always'
	| 'deny'
	| 'deny-always'
	| 'auto-allow'
	| 'auto-deny'
	| 'auto-prompt-required';

// --- File browser / git response shapes (shared by client & server) ---

export type ChangeStatus =
	| 'untracked'
	| 'ignored'
	| 'modified'
	| 'added'
	| 'deleted'
	| 'renamed'
	| 'conflicted';

export interface ChangeEntry {
	path: string;
	origPath: string | null;
	status: ChangeStatus;
	staged: boolean;
	unstaged: boolean;
	added: number | null;
	removed: number | null;
}

export interface ChangesResponse {
	initialized: boolean;
	entries: ChangeEntry[];
}
