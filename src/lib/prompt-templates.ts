import type {
	ChatPromptTemplate,
	PromptLaunchBehavior,
	PromptTemplateType,
	SessionMode,
	WorkspaceTicket
} from './types';

export type PromptTemplateSource = 'builtin' | 'custom';

export type PromptTemplateListItem = ChatPromptTemplate & {
	source: PromptTemplateSource;
};

export const BUILT_IN_PROMPT_TEMPLATES: ChatPromptTemplate[] = [
	{
		id: 'code-review',
		userId: null,
		type: 'chat',
		title: 'Code review',
		description: 'Review changed code for bugs, regressions, and security issues.',
		prompt:
			'Review the current code changes for correctness, security, and maintainability. Focus on issues that matter and suggest concrete fixes.',
		launchBehavior: 'draft',
		conversationMode: null,
		model: null,
		disabledToolGroups: [],
		workspaceMode: null,
		status: 'open',
		pinned: true,
		orderIndex: 10,
		createdAt: 0,
		updatedAt: 0,
		archivedAt: null
	},
	{
		id: 'debug-error',
		userId: null,
		type: 'chat',
		title: 'Debug an error',
		description: 'Investigate a failing command, stack trace, or unexpected behavior.',
		prompt:
			'I need help debugging an error. Start by asking for or inspecting the failing command/output, identify likely root causes, and propose the smallest safe fix.',
		launchBehavior: 'draft',
		conversationMode: null,
		model: null,
		disabledToolGroups: [],
		workspaceMode: null,
		status: 'open',
		pinned: true,
		orderIndex: 20,
		createdAt: 0,
		updatedAt: 0,
		archivedAt: null
	},
	{
		id: 'plan-implementation',
		userId: null,
		type: 'chat',
		title: 'Plan implementation',
		description: 'Create a focused implementation plan before changing code.',
		prompt:
			'Help plan this implementation. Inspect the relevant code paths, call out risks or open questions, and propose a concise step-by-step approach before editing.',
		launchBehavior: 'draft',
		conversationMode: null,
		model: null,
		disabledToolGroups: [],
		workspaceMode: null,
		status: 'open',
		pinned: false,
		orderIndex: 30,
		createdAt: 0,
		updatedAt: 0,
		archivedAt: null
	},
	{
		id: 'explain-code',
		userId: null,
		type: 'chat',
		title: 'Explain code',
		description: 'Explain how a feature, file, or flow works in this repository.',
		prompt:
			'Explain how this part of the codebase works. Trace the important files and data flow, and summarize the behavior, extension points, and gotchas.',
		launchBehavior: 'draft',
		conversationMode: null,
		model: null,
		disabledToolGroups: [],
		workspaceMode: null,
		status: 'open',
		pinned: false,
		orderIndex: 40,
		createdAt: 0,
		updatedAt: 0,
		archivedAt: null
	}
];

export function listBuiltInPromptTemplates(): PromptTemplateListItem[] {
	return BUILT_IN_PROMPT_TEMPLATES.map((template) => ({ ...template, source: 'builtin' }));
}

export function getBuiltInPromptTemplate(id: string): ChatPromptTemplate | null {
	return BUILT_IN_PROMPT_TEMPLATES.find((template) => template.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Launch resolution (Git workspace + per-launch overrides)
//
// A template pins the Git workspace its chats launch into (`shared` by default)
// and how it launches (`send`, `draft`, or `review`). A `review` launch collects
// the same values from the user first, so both paths funnel into one
// `TemplateLaunchOptions` shape that the client launchers consume.
// ---------------------------------------------------------------------------

/** Concrete workspace kinds a conversation can be created with. */
export type LaunchWorkspaceKind = 'shared' | 'worktree';

/** Prompt + settings a launch actually uses, after any review-dialog edits. */
export interface TemplateLaunchOptions {
	prompt: string;
	workspace: LaunchWorkspaceKind;
	conversationMode: SessionMode | null;
	model: string | null;
}

/** A template's effective workspace, collapsing "no preference" to `shared`. */
export function templateWorkspace(
	template: Pick<ChatPromptTemplate, 'workspaceMode'>
): LaunchWorkspaceKind {
	return template.workspaceMode ?? 'shared';
}

/** True when launching this template opens the review dialog first. */
export function templateNeedsReview(template: Pick<ChatPromptTemplate, 'launchBehavior'>): boolean {
	return template.launchBehavior === 'review';
}

/**
 * The launch options a template starts from: its stored settings plus the
 * already-interpolated prompt. Used directly for `send`/`draft` launches and as
 * the initial state of the review dialog.
 */
export function templateLaunchDefaults(
	template: Pick<ChatPromptTemplate, 'workspaceMode' | 'conversationMode' | 'model'>,
	prompt: string
): TemplateLaunchOptions {
	return {
		prompt,
		workspace: templateWorkspace(template),
		conversationMode: template.conversationMode ?? null,
		model: template.model ?? null
	};
}

/** Human-readable label for a launch behavior, used in settings and launchers. */
export function launchBehaviorLabel(behavior: PromptLaunchBehavior): string {
	if (behavior === 'draft') return 'Open draft';
	if (behavior === 'review') return 'Review before sending';
	return 'Send immediately';
}

/** Short launcher tag for a template's workspace preference, or `null` for the default. */
export function workspaceModeLabel(
	template: Pick<ChatPromptTemplate, 'workspaceMode'>
): string | null {
	return templateWorkspace(template) === 'worktree' ? 'Isolated worktree' : null;
}

// ---------------------------------------------------------------------------
// Placeholder registry + interpolation
//
// A single registry powers both save-time validation and launch-time
// interpolation so the two can never drift. Placeholders use `{{name}}` syntax
// (optional surrounding whitespace). Only names allowed for the template's type
// may appear; unknown placeholders are rejected on save.
// ---------------------------------------------------------------------------

const PLACEHOLDER_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

const PLACEHOLDERS_BY_TYPE: Record<PromptTemplateType, readonly string[]> = {
	chat: [],
	'ticket-action': ['ticket.title', 'ticket.id', 'ticket.body', 'ticket.plan']
};

export function placeholdersForType(type: PromptTemplateType): readonly string[] {
	return PLACEHOLDERS_BY_TYPE[type] ?? [];
}

/** Distinct placeholder names referenced by a prompt body, in first-seen order. */
export function extractPlaceholders(prompt: string): string[] {
	const seen = new Set<string>();
	for (const match of prompt.matchAll(PLACEHOLDER_RE)) {
		seen.add(match[1]);
	}
	return [...seen];
}

/** Placeholder names used by the prompt that are not allowed for its type. */
export function findUnknownPlaceholders(prompt: string, type: PromptTemplateType): string[] {
	const allowed = new Set(placeholdersForType(type));
	return extractPlaceholders(prompt).filter((name) => !allowed.has(name));
}

/**
 * Human-readable validation message for unknown `{{placeholders}}`. `chat`
 * templates support none, so we say so explicitly rather than implying some
 * other spelling would have worked.
 */
export function unknownPlaceholderMessage(type: PromptTemplateType, unknown: string[]): string {
	const list = unknown.map((name) => `{{${name}}}`).join(', ');
	const allowed = placeholdersForType(type);
	if (allowed.length === 0) {
		return `${type} templates don't support placeholders, but the prompt uses: ${list}`;
	}
	const allowedList = allowed.map((name) => `{{${name}}}`).join(', ');
	return `Unknown placeholder(s) for ${type} template: ${list}. Allowed: ${allowedList}`;
}

/**
 * Replace `{{name}}` placeholders using `values`. Unknown placeholders are
 * substituted with the empty string (validation already rejects them on save).
 * Collapses runs of blank lines left by empty substitutions and trims trailing
 * whitespace so an empty `{{ticket.body}}` doesn't leave dangling blank lines.
 */
export function interpolatePrompt(prompt: string, values: Record<string, string>): string {
	const replaced = prompt.replace(PLACEHOLDER_RE, (_, name: string) =>
		Object.prototype.hasOwnProperty.call(values, name) ? values[name] : ''
	);
	return replaced
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trimEnd();
}

// ---------------------------------------------------------------------------
// "Refine this prompt" seed
//
// Launching a refine session pre-fills the composer with a draft that targets
// one stored template by id. The seed intentionally does NOT inline the current
// prompt body — it tells the agent to read live state with `template_get` and
// apply agreed changes with `template_update` (both gated by the always-prompt
// permission), so the session can never act on a stale copy.
// ---------------------------------------------------------------------------

/** Human-readable label for a template type used in the refine seed text. */
function refineTemplateKindLabel(type: PromptTemplateType): string {
	return type === 'ticket-action' ? 'ticket action' : 'chat template';
}

/**
 * Seed prompt for a per-template "Refine this prompt" draft chat. Names the
 * template and embeds its id, and directs the agent to inspect current content
 * with `template_get` and apply improvements with `template_update` (proposing
 * changes + rationale first, applying on agreement).
 */
export function buildRefinePromptSeed(
	template: Pick<ChatPromptTemplate, 'id' | 'type' | 'title'>
): string {
	const kind = refineTemplateKindLabel(template.type);
	return [
		`Help me refine my saved ${kind} "${template.title}" (template id: ${template.id}).`,
		'',
		`Start by reading the template's current content with the \`template_get\` tool (id "${template.id}"). ` +
			'Then suggest concrete improvements to its prompt body — and, where useful, its title or description — ' +
			'to make it clearer, more specific, and more effective. Explain the rationale for each change first and ' +
			'wait for my agreement before applying anything.',
		'',
		`Apply the changes we agree on with the \`template_update\` tool (id "${template.id}"); each write will ask ` +
			'me to approve it. Keep the same intent and behavior — only sharpen how it is expressed.'
	].join('\n');
}

// ---------------------------------------------------------------------------
// Ticket-action defaults (seeded Do / Draft / Refine)
// ---------------------------------------------------------------------------

export interface TicketActionDefault {
	key: 'do' | 'draft' | 'refine';
	title: string;
	description: string;
	prompt: string;
	launchBehavior: PromptLaunchBehavior;
	conversationMode: SessionMode | null;
	/** Optional model override; `null` keeps the user's default model. */
	model: string | null;
	pinned: boolean;
	orderIndex: number;
}

const DO_PROMPT =
	'Do this workspace ticket: {{ticket.title}}\n\nTicket ID: {{ticket.id}}\n\n{{ticket.body}}\n\nPlan:\n{{ticket.plan}}';

const REFINE_PROMPT =
	'Refine this workspace ticket: {{ticket.title}}\n\n' +
	'Clarify the request, acceptance criteria, scope, risks, and useful implementation notes. ' +
	'Research the code if needed. Ask me the questions required to flesh out the ticket, driving ' +
	'each open decision to a concrete choice rather than leaving it ambiguous. Record those ' +
	'decisions in the ticket and build a concrete implementation plan with a checklist in the ' +
	"ticket's plan field. Update the ticket instead of implementing it unless explicitly asked." +
	'\n\nTicket ID: {{ticket.id}}\n\n{{ticket.body}}\n\nPlan:\n{{ticket.plan}}';

export const TICKET_ACTION_DEFAULTS: readonly TicketActionDefault[] = [
	{
		key: 'do',
		title: 'Do',
		description: 'Start an implementation chat for the ticket.',
		prompt: DO_PROMPT,
		launchBehavior: 'send',
		conversationMode: null,
		model: null,
		pinned: true,
		orderIndex: 10
	},
	{
		key: 'draft',
		title: 'Draft',
		description: 'Open an editable draft chat pre-filled with the ticket prompt.',
		prompt: DO_PROMPT,
		launchBehavior: 'draft',
		conversationMode: null,
		model: null,
		pinned: true,
		orderIndex: 20
	},
	{
		key: 'refine',
		title: 'Refine',
		description: 'Refine the ticket interactively instead of implementing it.',
		prompt: REFINE_PROMPT,
		launchBehavior: 'send',
		conversationMode: 'interactive',
		model: null,
		pinned: true,
		orderIndex: 30
	}
];

/** Deterministic id for a seeded ticket-action default, scoped per user. */
export function ticketActionDefaultId(userId: string, key: TicketActionDefault['key']): string {
	return `${userId}__tia_${key}`;
}

/** Placeholder values for interpolating a ticket-action prompt. */
export function ticketPlaceholderValues(
	ticket: Pick<WorkspaceTicket, 'id' | 'title' | 'body' | 'plan'>
): Record<string, string> {
	return {
		'ticket.title': ticket.title,
		'ticket.id': ticket.id,
		'ticket.body': ticket.body.trim(),
		'ticket.plan': ticket.plan.trim() || '(none)'
	};
}
