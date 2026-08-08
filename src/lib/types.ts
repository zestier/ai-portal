// Shared types used by both client and server.

import type { GrantScope } from './permissions/scope-types';
import type { TemplateBeforeSnapshot } from './permissions/prompt-template';
import type { GitCommitTargetSnapshot } from './permissions/git-commit';
import type { PortalToolGroupId } from './tools/groups';

export type Role = 'user' | 'assistant' | 'system';
export type MessageStatus = 'complete' | 'streaming' | 'interrupted' | 'error';
export type WorkspaceKind = 'shared' | 'managed-worktree';

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
	 * Agent mode for this conversation. Mirrors the SDK's `SessionMode`
	 * exactly:
	 *   - `interactive` (default): regular chat; the agent prompts for
	 *     permission and can call tools freely.
	 *   - `plan`: the agent plans without executing destructive tools and
	 *     surfaces an `exit_plan_mode` request before switching to execute.
	 *   - `autopilot`: less-supervised mode hint — the agent is expected to
	 *     work for long stretches with minimal user interaction.
	 *
	 * The mode is forwarded to the runtime each time the session is opened.
	 * How permission requests are settled is the orthogonal `approvalMode`
	 * axis, not a mode value.
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
	 * Optional per-conversation override for the memory extractor backend.
	 * Null means "use the server default backend" (env `MEMORY_EXTRACTOR_BACKEND`).
	 * Seeded from the user's default at creation; existing rows stay NULL.
	 */
	memoryExtractorBackend: MemoryExtractorBackend | null;
	/**
	 * Optional per-conversation override for the Phase 0 adversary shadow's
	 * reviewer model. NULL means "use the server default"
	 * (env `ADVERSARY_SHADOW_MODEL`); unset there too means the shadow is off.
	 *
	 * Seeded from the user's default at creation and NOT re-read afterwards,
	 * exactly like `memoryExtractorModel`: changing a user default never
	 * retroactively alters existing conversations, and clearing this column is
	 * a real "stop reviewing this conversation" rather than a silent
	 * re-inherit. That matters here — the reviewer is sent tool arguments, so
	 * per-conversation opt-out has to be reachable.
	 *
	 * Per-conversation rather than global because the shadow refuses to run when
	 * this equals the conversation's agent model on the same backend — a single
	 * global value is therefore guaranteed to silently disable itself for some
	 * conversations.
	 */
	adversaryModel: string | null;
	/**
	 * Optional per-conversation override for the backend serving the reviewer.
	 * NULL means "use `ADVERSARY_SHADOW_BACKEND`, else this conversation's own
	 * backend" — the fallback that lets a single-backend deployment run the
	 * shadow at all.
	 *
	 * Chosen independently of `adversaryModel` on purpose: reviewer independence
	 * is a property of the model's weights, not of which endpoint serves them.
	 */
	adversaryBackend: string | null;
	/**
	 * Explicit opt-in for user-scoped global memory tools in this conversation.
	 * Session memory remains per-conversation even when this is false.
	 */
	globalMemoryEnabled: boolean;
	/**
	 * How prompt-worthy tool-permission requests are settled in this
	 * conversation. Orthogonal to `mode`; see `ApprovalMode`.
	 */
	approvalMode: ApprovalMode;
	/**
	 * Portal tool groups the user has disabled for this conversation. Empty =
	 * all groups enabled (today's behaviour). Ids come from PORTAL_TOOL_GROUPS
	 * in `$lib/tools/groups`; providers drop the matching tools when assembling
	 * the session's portal tools, and a change forces a session recreate.
	 */
	disabledToolGroups: PortalToolGroupId[];
	createdAt: number;
	updatedAt: number;
	archivedAt: number | null;
	/** Set when this conversation was created by forking another one. */
	forkedFromConversationId: string | null;
	/** The message in the source conversation whose edit produced this fork. */
	forkedFromMessageId: string | null;
	/** Backend runtime session id. May rotate when a conversation is destructively rewritten. */
	providerSessionId: string;
	/**
	 * Pending composer draft seeded into the chat input on load. Set when an
	 * edit-fork is created while the source has a running turn (the fork's
	 * turn is deferred, not auto-started). Null when there is no pending draft.
	 */
	draftPrompt: string | null;
	/** Filesystem ownership model for this conversation. */
	workspaceKind: WorkspaceKind;
	/** Stable ticket namespace; managed worktrees inherit their source repository's key. */
	workspaceKey: string;
	/** Managed-worktree branch, otherwise null. */
	worktreeBranch: string | null;
	/** Commit from which the managed worktree was created, otherwise null. */
	worktreeBaseSha: string | null;
}

/**
 * A workspace's position relative to the branch checked out in its repository's
 * main checkout. Mirrors the server's `WorktreeIntegrationStatus`; see
 * `src/lib/server/worktree-integration.ts` for how each field is derived.
 */
export interface WorktreeIntegration {
	path: string;
	isLinkedWorktree: boolean;
	branch: string | null;
	upstreamPath: string;
	/** Repository-lock key; shared by the main worktree and every linked worktree. */
	gitCommonDir: string;
	upstreamBranch: string | null;
	ahead: number;
	behind: number;
	dirtyCount: number;
	upstreamDirtyCount: number;
	/** Holds commits or uncommitted changes the source branch does not have. */
	unmerged: boolean;
}

/** One row of `GET /api/worktrees/status`, the sidebar's unmerged-work badge feed. */
export interface WorktreeStatusSummary {
	conversationId: string;
	/** False when the checkout is missing or unreadable; every other field is then absent. */
	available: boolean;
	unmerged: boolean;
	branch?: string | null;
	upstreamBranch?: string | null;
	ahead?: number;
	behind?: number;
	dirtyCount?: number;
}

export type WorkspaceTicketStatus = 'open' | 'done' | 'archived';

/**
 * Relative urgency of a workspace ticket. `P0` is the highest urgency and `P3`
 * the lowest; new tickets default to `P2` (normal). The same set is enforced by
 * the DB `CHECK`, the agent tool Zod schemas, and the REST API validation so a
 * bad value fails fast at every layer.
 */
export type WorkspaceTicketPriority = 'P0' | 'P1' | 'P2' | 'P3';

/** Default priority for a new ticket (matches the DB column default). */
export const DEFAULT_TICKET_PRIORITY: WorkspaceTicketPriority = 'P2';

/** The allowed ticket priorities, highest urgency (P0) first. */
export const TICKET_PRIORITIES: readonly WorkspaceTicketPriority[] = ['P0', 'P1', 'P2', 'P3'];

export interface WorkspaceTicket {
	id: string;
	userId: string;
	workspaceKey: string;
	title: string;
	body: string;
	/** Relative urgency, P0 (highest) … P3 (lowest). Defaults to P2. */
	priority: WorkspaceTicketPriority;
	/**
	 * Durable, free-form implementation plan / design notes / checklist. Longer
	 * than `body` and omitted from the agent tools' compact view (fetch it via
	 * the `fields` selector). Empty string when unset.
	 */
	plan: string;
	status: WorkspaceTicketStatus;
	sourceConversationId: string | null;
	sourceMessageId: string | null;
	createdAt: number;
	updatedAt: number;
	closedAt: number | null;
}

/**
 * A lightweight reference to a ticket on the other end of a dependency edge,
 * carrying just enough to render it (and link to it) without loading the full
 * row. Used by the ticket detail page's dependency display.
 */
export interface TicketDependencyRef {
	id: string;
	title: string;
	status: WorkspaceTicketStatus;
}

export interface TicketAttachmentMeta {
	id: string;
	ticketId: string;
	filename: string;
	mimeType: string;
	byteSize: number;
	createdAt: number;
}

/**
 * A workspace ticket enriched with its still-open prerequisites for the sidebar
 * list. `blockers` is the subset of the ticket's prerequisites that are still
 * `open` (and therefore actively blocking it); an empty array means the ticket
 * is ready to start. Carries blocker titles so the sidebar can show a tooltip
 * without cross-referencing the rendered window.
 */
export interface SidebarTicket extends WorkspaceTicket {
	blockers: TicketDependencyRef[];
}

export type PromptTemplateStatus = 'open' | 'archived';

/**
 * Prompt templates are typed. The type governs which `{{placeholders}}` may be
 * injected at launch and how/where the template surfaces in the UI:
 * - `chat`: the original launcher templates, injected verbatim (no placeholders).
 * - `ticket-action`: rendered as a button on each workspace ticket; may inject
 *   `{{ticket.*}}` placeholders and carries ticket-action launch metadata.
 */
export type PromptTemplateType = 'chat' | 'ticket-action';

export const PROMPT_TEMPLATE_TYPES: readonly PromptTemplateType[] = ['chat', 'ticket-action'];

export function normalizePromptTemplateType(raw: string | null | undefined): PromptTemplateType {
	return raw === 'ticket-action' ? 'ticket-action' : 'chat';
}

/**
 * How a prompt template launches the chat it creates:
 * - `send`: post the (interpolated) prompt as a turn immediately;
 * - `draft`: pre-fill the composer for the user to edit and send;
 * - `review`: open a pre-launch dialog to edit the prompt *and* the launch
 *   options (conversation mode, model, Git workspace) before sending.
 *
 * Applies to both template types. Stored `null` means "type default": `draft`
 * for chat templates (their historical behavior) and `send` for ticket actions.
 */
export type PromptLaunchBehavior = 'send' | 'draft' | 'review';

export const PROMPT_LAUNCH_BEHAVIORS: readonly PromptLaunchBehavior[] = ['send', 'draft', 'review'];

/** The launch behavior used when a template stores none. */
export function defaultLaunchBehavior(type: PromptTemplateType): PromptLaunchBehavior {
	return type === 'chat' ? 'draft' : 'send';
}

export function normalizeLaunchBehavior(
	raw: string | null | undefined,
	type: PromptTemplateType
): PromptLaunchBehavior {
	if (raw === 'send' || raw === 'draft' || raw === 'review') return raw;
	return defaultLaunchBehavior(type);
}

/**
 * Git workspace style a prompt template launches its conversation into:
 * - `shared`: the shared checkout (today's default),
 * - `worktree`: a fresh managed Git worktree, isolated from the shared checkout.
 *
 * `null` on a template means "no preference" and behaves like `shared`. Picking
 * a workspace per launch is not a mode here — that is `launchBehavior: 'review'`,
 * which lets the user change this (and the other options) before sending.
 */
export type PromptTemplateWorkspaceMode = 'shared' | 'worktree';

export const PROMPT_TEMPLATE_WORKSPACE_MODES: readonly PromptTemplateWorkspaceMode[] = [
	'shared',
	'worktree'
];

/** Parse a stored/submitted workspace mode, collapsing anything unknown to `null`. */
export function normalizePromptTemplateWorkspaceMode(
	raw: string | null | undefined
): PromptTemplateWorkspaceMode | null {
	return raw === 'shared' || raw === 'worktree' ? raw : null;
}

export interface ChatPromptTemplate {
	id: string;
	/** Built-in templates are static and not owned by a user. */
	userId: string | null;
	type: PromptTemplateType;
	title: string;
	description: string;
	prompt: string;
	/**
	 * How this template launches its chat (`send` | `draft` | `review`). Applies
	 * to both template types; always resolved (never `null`) on a loaded row.
	 */
	launchBehavior: PromptLaunchBehavior;
	/**
	 * Optional conversation-mode override applied when this template creates its
	 * conversation. `null` means use the user's default mode.
	 */
	conversationMode: SessionMode | null;
	/**
	 * Optional approval-mode override applied when this template creates its
	 * conversation. `null` means use the user's default approval mode.
	 */
	approvalMode: ApprovalMode | null;
	/**
	 * Optional model override applied when this template creates its
	 * conversation. `null` means use the user's default model. A stale id (no
	 * longer offered by the provider) is passed through unchanged.
	 */
	model: string | null;
	/**
	 * Portal tool groups to seed as *disabled* on the conversation a `chat`
	 * template launches (ids from `$lib/tools/groups`). `[]` for chat templates
	 * with no preset and always `[]` for ticket-action templates. This is only a
	 * seed — the created conversation's own `disabledToolGroups` remains the
	 * source of truth and the user can change it afterward.
	 */
	disabledToolGroups: PortalToolGroupId[];
	/**
	 * Git workspace style for chats launched from this template. `null` means no
	 * preference — the launcher uses the shared checkout. Applies to both
	 * template types since both create conversations.
	 */
	workspaceMode: PromptTemplateWorkspaceMode | null;
	status: PromptTemplateStatus;
	pinned: boolean;
	orderIndex: number;
	createdAt: number;
	updatedAt: number;
	archivedAt: number | null;
}

// Portal session modes — exactly the runtime's set. There is no portal-only
// extension: the auto-deny behaviour that used to ride on `best-effort` lives
// on the orthogonal `ApprovalMode` axis.
export const SESSION_MODES = ['interactive', 'plan', 'autopilot'] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

export function normalizeSessionMode(raw: string | null | undefined): SessionMode {
	// Legacy rows/payloads may still carry the retired `best-effort` mode. On
	// the runtime axis it always *was* autopilot (the bridge remapped it before
	// the SDK saw it), so that is the honest landing spot; the auto-deny half is
	// carried by `approval_mode` (see migration 066).
	if (raw === 'best-effort') return 'autopilot';
	return raw === 'plan' || raw === 'autopilot' ? raw : 'interactive';
}

/**
 * How the portal settles a tool-permission request that neither a grant nor
 * the user's policy has already decided. Orthogonal to `SessionMode`, and
 * deliberately coarse — finer-grained rules belong in the policy + grants
 * system, not here.
 *
 *   - `ask` (default): raise the permission dialog and wait for the human.
 *   - `auto-approve`: settle every prompt-worthy request as an approval (an
 *     `auto-allow` audit row is still written). Mirrored to providers that
 *     support it so the model knows it runs less supervised.
 *   - `auto-deny`: reject prompt-worthy requests with actionable feedback
 *     instead of blocking on a dialog the user may never see. Pure portal-side
 *     logic, so it works for every provider.
 *
 * `request_permission_grant` and a valid `force_retry_tool` (one-shot token
 * from a denial) always reach a human regardless of this setting.
 */
export const APPROVAL_MODES = ['ask', 'auto-approve', 'auto-deny'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export function normalizeApprovalMode(raw: string | null | undefined): ApprovalMode {
	return raw === 'auto-approve' || raw === 'auto-deny' ? raw : 'ask';
}

export type MemoryMode = 'off' | 'lightweight' | 'project' | 'story' | 'strict';

export function normalizeMemoryMode(raw: string | null | undefined): MemoryMode {
	return raw === 'lightweight' || raw === 'project' || raw === 'story' || raw === 'strict'
		? raw
		: 'off';
}

// Single source of truth for the model-backed memory extractor backends.
// Reused by the config zod enum, the settings save schema, the conversation
// row normalizer, and the UI selectors so the set can't drift.
export const MEMORY_EXTRACTOR_BACKEND_IDS = [
	'heuristic',
	'openai-compatible',
	'openai-compatible-tools'
] as const;
export type MemoryExtractorBackend = (typeof MEMORY_EXTRACTOR_BACKEND_IDS)[number];

/**
 * Normalizes a stored/posted extractor backend. NULL/unknown means "use the
 * server default" (env `MEMORY_EXTRACTOR_BACKEND`), preserving behaviour for
 * every existing conversation whose column is NULL.
 */
export function normalizeMemoryExtractorBackend(
	raw: string | null | undefined
): MemoryExtractorBackend | null {
	return MEMORY_EXTRACTOR_BACKEND_IDS.includes(raw as MemoryExtractorBackend)
		? (raw as MemoryExtractorBackend)
		: null;
}

// Context window tier for Copilot sessions. `long_context` is the large (e.g.
// 1M-token) window — a premium, separately-billed tier that newer Copilot CLIs
// gate behind an explicit opt-in; `default` is the standard (~200k) window.
// Single source of truth shared by the config zod enum, the settings save
// schema, the repo normalizer, and the UI selector so the set can't drift.
export const CONTEXT_TIER_IDS = ['default', 'long_context'] as const;
export type ContextTier = (typeof CONTEXT_TIER_IDS)[number];

/**
 * Normalizes a stored/posted context tier. NULL/unknown means "use the server
 * default" (env `COPILOT_CONTEXT_TIER`), so a user who never picks a tier
 * inherits the instance-wide setting. An explicit `default` lets a user pin the
 * standard window even when the server default is `long_context`.
 */
export function normalizeContextTier(raw: string | null | undefined): ContextTier | null {
	return raw === 'default' || raw === 'long_context' ? raw : null;
}

// Selectable accent palettes. Orthogonal to the dark/light/system *mode*:
// the accent only re-tints `--accent`/`--accent-text` (and the tints derived
// from them) so a portal instance can be made visually distinct at a glance —
// handy when running several copies for different projects. `default` keeps
// the per-mode blue defined in app.css. Single source of truth shared by the
// settings save schema, the repo normalizer, and the UI selector.
//
// `hex` is the representative accent colour, also used to tint the favicon
// (see faviconDataUri). These MUST stay in sync with the `[data-accent='…']`
// blocks in src/app.css — CSS can't import this module, so the values are
// duplicated there by necessity. `default`'s hex matches the dark-mode
// `--accent` (#1f6feb).
export const THEME_ACCENTS = [
	{ value: 'default', label: 'Blue (default)', hex: '#1f6feb' },
	{ value: 'violet', label: 'Violet', hex: '#8957e5' },
	{ value: 'teal', label: 'Teal', hex: '#1f9c9c' },
	{ value: 'green', label: 'Green', hex: '#2da44e' },
	{ value: 'amber', label: 'Amber', hex: '#bb8009' },
	{ value: 'rose', label: 'Rose', hex: '#d6336c' },
	{ value: 'crimson', label: 'Crimson', hex: '#cf222e' }
] as const;
export type ThemeAccent = (typeof THEME_ACCENTS)[number]['value'];
export const THEME_ACCENT_IDS = THEME_ACCENTS.map((a) => a.value) as readonly ThemeAccent[];

export function normalizeThemeAccent(raw: string | null | undefined): ThemeAccent {
	return THEME_ACCENT_IDS.includes(raw as ThemeAccent) ? (raw as ThemeAccent) : 'default';
}

export function themeAccentHex(accent: ThemeAccent): string {
	return (THEME_ACCENTS.find((a) => a.value === accent) ?? THEME_ACCENTS[0]).hex;
}

/**
 * The portal favicon as an `data:image/svg+xml` URI, tinted with the given
 * accent. An SVG favicon can't read the page's CSS variables, so the colour
 * is baked in server-side and injected into <link rel="icon"> (see
 * hooks.server.ts). This is the sole source of the favicon artwork; the
 * `default` accent (#1f6feb) is its untinted blue. Allowed by the
 * `img-src 'self' data:` CSP directive.
 */
export function faviconDataUri(accent: ThemeAccent): string {
	const color = themeAccentHex(accent);
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
		`<rect width="32" height="32" rx="6" fill="${color}"/>` +
		`<path fill="#fff" d="M8 12c0-2 1.5-3 3-3h10c1.5 0 3 1 3 3v6c0 4-4 6-8 6s-8-2-8-6v-6Zm5 3a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm6 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"/>` +
		`</svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const BACKEND_PROVIDER_IDS = [
	'copilot',
	'claude-agent',
	'openai-compatible',
	'lm-studio'
] as const;
export type BackendProviderId = (typeof BACKEND_PROVIDER_IDS)[number];

export function normalizeBackendProvider(raw: string | null | undefined): BackendProviderId {
	return BACKEND_PROVIDER_IDS.includes(raw as BackendProviderId)
		? (raw as BackendProviderId)
		: 'copilot';
}

export type ProviderRuntimeFeature =
	| 'modes'
	| 'approvalMode'
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
		/** Supports live runtime modes such as plan/autopilot. */
		mode: boolean;
		/**
		 * Supports mirroring the `auto-approve` approval mode into the runtime.
		 * `ask` and `auto-deny` are enforced portal-side and need no provider
		 * support, so only `auto-approve` is gated on this.
		 */
		approvalMode: boolean;
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
	/**
	 * Local load/unload inference backends (e.g. Ollama via openai-compatible,
	 * LM Studio) keep one model resident and evict it when a *different* model
	 * runs. When `primeAfterModelSwap` is true, the runtime may proactively
	 * re-warm ("prime") the main chat model after background work — chiefly the
	 * model-backed memory extractor loading a different model — so the next user
	 * turn does not pay a cold model-load stall. Cloud providers report false:
	 * they have no local load/unload (and thus no cold-load) to prime around.
	 */
	localModelLoad: {
		primeAfterModelSwap: boolean;
	};
	/**
	 * Whether the provider can serve a one-shot, tool-less, out-of-band
	 * completion via `ModelBackendProvider.complete` — a model call that is not
	 * a conversation turn and produces no portal events.
	 *
	 * Used by background reviewers (currently the adversary shadow) so they can
	 * run on the conversation's OWN backend rather than requiring the operator
	 * to stand up a second endpoint. Independence from the agent is a property
	 * of choosing a different *model*, not a different *backend*.
	 */
	sideCompletion: boolean;
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
	// Null only on a trimmed conversation-open payload (see `textTruncated`) —
	// never for a live/streamed or untrimmed record.
	text: string | null;
	// Set only on a trimmed conversation-open payload: the stored text exceeded
	// INLINE_REASONING_MAX_BYTES and was replaced by this marker plus its byte
	// size. ReasoningBlock fetches the real text when the user expands it.
	textTruncated?: boolean;
	textBytes?: number;
	// 'reasoning' = model thinking ("Thinking…"); 'content' = a sub-agent's
	// spoken output, threaded into its card so a nested agent renders its
	// response interleaved with its tools/reasoning like a top-level agent.
	// 'content' blocks are rendered unconditionally, so they are never trimmed.
	kind: 'reasoning' | 'content';
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
	// NULL when the field was omitted from a trimmed page payload (see
	// `argsTruncated`) — never for a live/streamed or untrimmed record.
	argsJson: string | null;
	resultJson: string | null;
	// Set only on a trimmed conversation-open payload: the stored field
	// exceeded INLINE_FIELD_MAX_BYTES and was replaced by this marker plus its
	// byte size. The client fetches the real text on first expand. Deliberately
	// a separate flag rather than a sentinel string so that anything which
	// JSON.parses the field is a compile error, not a runtime throw.
	argsTruncated?: boolean;
	argsBytes?: number;
	resultTruncated?: boolean;
	resultBytes?: number;
	status: 'pending' | 'ok' | 'error' | 'denied';
	startedAt: number;
	endedAt: number | null;
	textOffset: number | null;
	// See ReasoningBlockRecord.parentToolCallId. Sub-agents can in turn
	// invoke their own tools — including `task`, spawning a nested sub-agent —
	// so this points at the `task` call that *immediately* spawned the emitting
	// agent, not the outermost one. The chain can therefore be several levels
	// deep and is rendered recursively by SubagentCall.
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
	// Binary artifacts side-stored for this tool call (currently images
	// captured for a native `view`). Metadata only — the bytes are served
	// lazily through an authed endpoint. Populated on conversation load and
	// on the live `tool.result` event; absent while the tool is still running.
	attachments?: ToolAttachmentMeta[];
}

export interface ToolAttachmentMeta {
	id: string;
	toolCallId: string;
	kind: 'image';
	mimeType: string;
	byteSize: number;
}

export interface FileEditRecord {
	id: string;
	messageId: string;
	path: string;
	// NULL when omitted from a trimmed page payload; see
	// ToolCallRecord.argsTruncated.
	diff: string | null;
	diffTruncated?: boolean;
	diffBytes?: number;
	createdAt: number;
	textOffset: number | null;
	// See ReasoningBlockRecord.parentToolCallId.
	parentToolCallId: string | null;
}

// Observability record of the *full input* the portal handed to the provider
// for the turn triggered by a given user message. Surfaced read-only in the UI
// so the user can inspect the portal prelude + any memory / prior-message
// context injected on top of their raw message — "the guts" of the turn.
export interface TurnInput {
	messageId: string;
	conversationId: string;
	turnId: string | null;
	// Exact string sent to the provider (prelude + body).
	fullInput: string;
	// Body without the auto-injected portal prelude.
	promptBody: string;
	// The portal prelude actually prepended (empty when none was applied).
	prelude: string;
	provider: string | null;
	model: string | null;
	mode: string | null;
	memoryMode: string | null;
	// Prior messages embedded for providers that can't resume a session.
	initialMessages: ProviderInitialMessagePreview[] | null;
	createdAt: number;
}

export interface ProviderInitialMessagePreview {
	role: string;
	content: string;
}

export interface UserSettings {
	defaultProvider: BackendProviderId;
	defaultModel: string | null;
	defaultWorkdir: string | null;
	defaultConversationMode: SessionMode;
	defaultApprovalMode: ApprovalMode;
	defaultPolicy: PermissionPolicy;
	theme: 'dark' | 'light' | 'system';
	/** Accent palette, applied on top of the dark/light mode (see ThemeAccent). */
	accent: ThemeAccent;
	/**
	 * Seed-only defaults for the memory extractor, copied onto each newly
	 * created conversation. NULL = "use server default" (env). Changing these
	 * never retroactively alters existing conversations.
	 */
	defaultMemoryExtractorModel: string | null;
	defaultMemoryExtractorBackend: MemoryExtractorBackend | null;
	/**
	 * Seed-only default for the Phase 0 adversary shadow's reviewer model,
	 * copied onto each newly created conversation (like the memory extractor
	 * defaults). NULL = "use the server default" (env `ADVERSARY_SHADOW_MODEL`);
	 * unset everywhere means the shadow never runs. Setting a model is what
	 * enables it — there is deliberately no separate on/off flag to disagree
	 * with. Changing this never retroactively alters existing conversations.
	 */
	defaultAdversaryModel: string | null;
	/**
	 * Seed-only default for the backend that serves the reviewer. NULL = "use
	 * `ADVERSARY_SHADOW_BACKEND`, else the conversation's own backend". Chosen
	 * independently of the model because reviewer independence is a property of
	 * the weights, not of which endpoint serves them.
	 */
	defaultAdversaryBackend: string | null;
	/**
	 * Per-user context window tier, consumed live when a Copilot session opens.
	 * NULL = "use the server default" (env `COPILOT_CONTEXT_TIER`). Unlike the
	 * seed-only defaults above, changing this affects subsequent session opens
	 * for existing conversations too (the tier is resolved at open/resume time).
	 */
	defaultContextTier: ContextTier | null;
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
	| 'external_tool'
	// Checked-in workspace permissions (.zap/permissions.toml): a non-blocking
	// review raised when the file on disk drifts from the last human-approved
	// snapshot. Approving imports the new file as grants; rejecting keeps the
	// old state. The turn does not wait on it (old grants stay active).
	| 'workspace_file';

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
	 * False for sensitive one-shot permissions. The dialog must not
	 * offer persistent allow/deny actions, and the server rejects them.
	 */
	canPersistDecision?: boolean;
	/**
	 * Set when an otherwise auto-rejected request intentionally escalates to
	 * a human prompt after a feedback-bearing deny grant.
	 */
	escalationReason?: string;
	/**
	 * Present when this dialog was raised by the `request_permission_grant`
	 * tool: the agent is proposing a permanent, structured permission grant
	 * for a human to review, narrow, or reject. Unlike an ordinary permission
	 * dialog (which gates a single in-flight tool call), the *only* effect of
	 * approving this is persisting the proposed grant — so the dialog renders
	 * the proposed scope's full breadth and offers "Save grant" / "Deny"
	 * rather than allow-once. The request always reaches a human; it is never
	 * auto-approved by policy or the session approve-all toggle.
	 */
	grantRequest?: PermissionGrantRequest;
	/**
	 * Initial text for the deny feedback field. Prompt-required grants use
	 * this to suggest the same feedback that would be sent on auto-deny.
	 */
	defaultDenyFeedback?: string | undefined;
	/**
	 * For `shell` permissions: the server-side parser's verdict on the
	 * command. `parsed` means we tokenized it into segments split on
	 * `&&`/`||`/`;`/`|`; the dialog uses this to break the pipeline out
	 * and offer per-argv0 grants. `unsafe` means the command contains
	 * constructs (subshells, redirection, var expansion, ...) we refused
	 * to model; structured grants can't apply, so the dialog warns the
	 * user and downgrades the grant picker. Omitted for non-shell kinds.
	 */
	shellAnalysis?: ShellAnalysisView | undefined;
	/**
	 * A bounded inline preview of an image the agent is about to `view`. The
	 * portal captures readable image bytes at permission (read) time so the
	 * user can see what they're approving before deciding. Only present when
	 * the read prompts (in-workspace reads are typically auto-allowed with no
	 * dialog), the target is an allowlisted image type, and the bytes are
	 * small enough to embed. `dataBase64` is the raw base64 (no data: prefix).
	 */
	imagePreview?: ImagePreview | undefined;
	/**
	 * For `template_update`: a read-only snapshot of the existing template's
	 * resolved values, loaded server-side by id + userId. Lets the dialog render
	 * a merged before→after preview (current vs. proposed for each field) instead
	 * of a patch view. Omitted for `template_create` and when the target id is
	 * missing/deleted (the dialog then falls back to the patch view).
	 */
	templateBefore?: TemplateBeforeSnapshot | undefined;
	/**
	 * For `git_commit` with a `worktree` selector: the lease's label, branch, and
	 * checkout path, resolved server-side from the id in the args. Lets the dialog
	 * name WHERE the commit lands — a commit into a worktree touches a different
	 * checkout and branch than the conversation's own workspace, and the raw args
	 * carry only an opaque id. Omitted when no worktree was requested.
	 */
	commitTarget?: GitCommitTargetSnapshot | undefined;
}

export interface ImagePreview {
	mimeType: string;
	dataBase64: string;
	byteSize: number;
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
	errorCode?: string | undefined;
	retryAfterSeconds?: number | undefined;
}

export interface InteractiveUserInputView {
	kind: 'user_input';
	question: string;
	choices?: string[] | undefined;
	allowFreeform: boolean;
}

export interface InteractiveElicitationView {
	kind: 'elicitation';
	message: string;
	mode: 'form' | 'url';
	url?: string | undefined;
	requestedSchema?: ElicitationSchema | undefined;
	elicitationSource?: string | undefined;
}

export interface InteractiveExitPlanModeView {
	kind: 'exit_plan_mode';
	summary: string;
	planContent?: string | undefined;
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

/**
 * Review for the checked-in workspace permissions file
 * (`.zap/permissions.toml`). Raised by the permission gate when the file on
 * disk no longer matches the last human-approved snapshot: the diff is the
 * whole point, so the dialog shows the change and the human approves it into
 * the active grant set or keeps the old state. Non-blocking — the request
 * that triggered the check proceeds against the current (old) grants either
 * way.
 */
export interface InteractiveWorkspaceFileView {
	kind: 'workspace_file';
	/** Absolute path to the workspace root this file governs. */
	workspaceRoot: string;
	/** Display path of the permissions file, e.g. `.zap/permissions.toml`. */
	fileName: string;
	/** Current file contents as captured by the gate. */
	currentText: string;
	/** SHA-256 of `currentText`; null when the file is gone (deletion). */
	currentHash: string | null;
	/** Hash of the last human-approved snapshot, or null on first import. */
	acceptedHash: string | null;
	/** The last approved snapshot text, or null on first import. */
	oldSnapshot: string | null;
	/** Unified diff old-snapshot ↔ current file. */
	diff: string;
	/** Number of grants currently active from the last approved snapshot. */
	activeGrantCount: number;
	/**
	 * Set when the current file fails to parse. The dialog must not offer
	 * approve then; the gate's validation doubles as a second line of defense
	 * against a malformed file being imported silently.
	 */
	parseError?: string;
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
	| InteractiveExternalToolView
	| InteractiveWorkspaceFileView;

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
	| { kind: 'external_tool'; action: 'ack' }
	| {
			kind: 'workspace_file';
			decision: 'approve' | 'reject';
	  };

/**
 * The agent-proposed grant carried by a `request_permission_grant` dialog.
 * `scope` is the structured grant the agent wants persisted; `permissionKind`
 * is the matcher tool it will be stored under (e.g. `shell`, `write`). The
 * proposal only *pre-fills* the human's decision — the human can deny it, and
 * what gets persisted is whatever the dialog emits on approval, never this
 * payload directly.
 */
export interface PermissionGrantRequest {
	/** Human-readable reason the agent gave for needing this grant. */
	reason: string;
	/** The structured scope the agent proposes to be granted. */
	scope: GrantScope;
	/** Matcher tool / permission kind the grant will be stored under. */
	permissionKind: string;
}

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
	| {
			type: 'message.delta';
			messageId: string;
			text: string;
			// When set, this content originated inside the sub-agent spawned by
			// the outer `task` tool call with this id, and (with segmentId) is
			// rendered as a threaded content block inside the SubagentCall card
			// rather than appended to the outer assistant message body.
			parentToolCallId?: string | undefined;
			// Groups consecutive child content deltas into one block. Only set
			// for sub-agent content (alongside parentToolCallId).
			segmentId?: string;
	  }
	| {
			type: 'message.reasoning';
			messageId: string;
			segmentId: string;
			text: string;
			// When set, this reasoning burst originated inside the sub-agent
			// spawned by the outer `task` tool call with this id.
			parentToolCallId?: string | undefined;
	  }
	| {
			type: 'message.reasoning.end';
			messageId: string;
			segmentId: string;
			durationMs: number;
			parentToolCallId?: string | undefined;
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
			parentToolCallId?: string | undefined;
			// The assistant message this call is anchored to. Set when the event
			// is emitted to clients so the UI can target by id (like
			// `message.delta`) instead of assuming the last message is the active
			// assistant turn — which breaks across a reconnect gap. Optional
			// because lower-level SDK/provider emitters dispatch before the
			// assistant message is persisted.
			messageId?: string | undefined;
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
			parentToolCallId?: string | undefined;
			attachments?: ToolAttachmentMeta[];
	  }
	// Ephemeral live-streaming events from the SDK during a tool's execution.
	// Forwarded to subscribers but intentionally NOT appended to the turn's
	// event log: reconnects pick up the authoritative final state via
	// `tool.result` and don't need to replay stale partial chunks.
	| {
			type: 'tool.partial_output';
			toolCallId: string;
			output: string;
			parentToolCallId?: string | undefined;
	  }
	| {
			type: 'tool.progress';
			toolCallId: string;
			message: string;
			parentToolCallId?: string | undefined;
	  }
	| {
			type: 'file.edit';
			path: string;
			diff: string;
			parentToolCallId?: string | undefined;
			// Assistant message anchor; see the note on `tool.call`.
			messageId?: string | undefined;
	  }
	| { type: 'conversation.update'; conversationId: string; title?: string }
	| {
			type: 'session.settings';
			conversationId: string;
			mode?: SessionMode;
			memoryMode?: MemoryMode;
			approvalMode?: ApprovalMode;
			disabledToolGroups?: PortalToolGroupId[];
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
	| { type: 'done'; status?: 'complete' | 'interrupted' | 'error' };

// --- App-level (cross-conversation) event feed ---
//
// `PortalEvent` is scoped to a single turn's stream — a client only hears
// about the one conversation/turn it has open. `AppEvent` is the envelope for
// the per-user *global* feed (`GET /api/events`): lightweight signals that the
// app shell subscribes to once and that may concern *any* of the user's
// conversations. Kept as its own discriminated union (not an extension of
// `PortalEvent`) so the two channels evolve independently.
//
// First member: a conversation's "awaiting user input" state changed — emitted
// on the transition into/out of having ≥1 outstanding blocking interactive
// prompt (see `isBlockingKind`). Second: any of the user's workspace tickets
// changed (add/update/status/block/unblock/remove, from a tool or the REST
// endpoints) — a content-free nudge for the app shell to re-fetch the sidebar
// ticket list. The channel is designed to carry further cross-conversation
// signals later (title updates, memory status, …).
export type AppEvent =
	| {
			type: 'awaiting.changed';
			conversationId: string;
			awaiting: boolean;
	  }
	// Content-free: it carries no ticket/workspace id because the client refresh
	// is user-global (`invalidateAll()` re-runs the layout `load`). The repo
	// notifier does pass a `ticketId`/`workspaceKey` for future filtering, but
	// the feed deliberately doesn't expose them yet.
	| { type: 'tickets.changed' }
	// A conversation's sidebar "active" state changed. Always a FULL snapshot of
	// both dimensions (not a delta) so a client that missed an earlier event
	// still converges: `running` = a turn is in flight, `unread` = there is
	// assistant output the user hasn't seen. Emitted when a turn starts, when it
	// finalizes, and when a conversation is marked read.
	| {
			type: 'activity.changed';
			conversationId: string;
			running: boolean;
			unread: boolean;
	  };

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
// required under the `auto-deny` approval mode.
export type PermissionDecision =
	| 'allow-once'
	| 'allow-always'
	| 'deny'
	| 'deny-always'
	| 'auto-allow'
	| 'auto-deny'
	| 'auto-prompt-required'
	// Recorded when a still-open prompt was abandoned because the turn was
	// aborted (or the prompt timed out / the client disconnected) before the
	// user answered. Distinct from `auto-deny` so the audit shows the prompt
	// was cancelled, not denied.
	| 'auto-cancelled'
	// Recorded when the SDK session backing a still-open prompt was reclaimed
	// (capacity eviction) before the user answered. Distinct from `auto-deny`
	// so the audit shows the prompt was abandoned by the server, not denied.
	| 'auto-expired';

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
