import type {
	ApprovalMode,
	ChatPromptTemplate,
	PromptLaunchBehavior,
	PromptTemplateType,
	SessionMode,
	WorkspaceTicket
} from './types';
import type { PortalToolGroupId } from './tools/groups';

export type PromptTemplateSource = 'builtin' | 'custom';

export type PromptTemplateListItem = ChatPromptTemplate & {
	source: PromptTemplateSource;
};

export const BUILT_IN_PROMPT_TEMPLATES: ChatPromptTemplate[] = [
	{
		id: '-1',
		userId: null,
		type: 'chat',
		title: 'Code review',
		description: 'Review changed code for bugs, regressions, and security issues.',
		prompt:
			'Review the current code changes for correctness, security, and maintainability. Focus on issues that matter and suggest concrete fixes.',
		launchBehavior: 'draft',
		conversationMode: null,
		approvalMode: null,
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
		id: '-2',
		userId: null,
		type: 'chat',
		title: 'Debug an error',
		description: 'Investigate a failing command, stack trace, or unexpected behavior.',
		prompt:
			'I need help debugging an error. Start by asking for or inspecting the failing command/output, identify likely root causes, and propose the smallest safe fix.',
		launchBehavior: 'draft',
		conversationMode: null,
		approvalMode: null,
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
		id: '-3',
		userId: null,
		type: 'chat',
		title: 'Plan implementation',
		description: 'Create a focused implementation plan before changing code.',
		prompt:
			'Help plan this implementation. Inspect the relevant code paths, call out risks or open questions, and propose a concise step-by-step approach before editing.',
		launchBehavior: 'draft',
		conversationMode: null,
		approvalMode: null,
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
		id: '-4',
		userId: null,
		type: 'chat',
		title: 'Explain code',
		description: 'Explain how a feature, file, or flow works in this repository.',
		prompt:
			'Explain how this part of the codebase works. Trace the important files and data flow, and summarize the behavior, extension points, and gotchas.',
		launchBehavior: 'draft',
		conversationMode: null,
		approvalMode: null,
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
	approvalMode: ApprovalMode | null;
	model: string | null;
	/**
	 * Portal tool groups disabled on the launched conversation. Seeded from the
	 * template's preset; the review dialog can edit it (a launch always sends
	 * this array to the API — even when empty — so a cleared preset sticks).
	 */
	disabledToolGroups: PortalToolGroupId[];
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
	template: Pick<
		ChatPromptTemplate,
		'workspaceMode' | 'conversationMode' | 'approvalMode' | 'model' | 'disabledToolGroups'
	>,
	prompt: string
): TemplateLaunchOptions {
	return {
		prompt,
		workspace: templateWorkspace(template),
		conversationMode: template.conversationMode ?? null,
		approvalMode: template.approvalMode ?? null,
		model: template.model ?? null,
		disabledToolGroups: template.disabledToolGroups ?? []
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
	approvalMode: ApprovalMode | null;
	/** Optional model override; `null` keeps the user's default model. */
	model: string | null;
	pinned: boolean;
	orderIndex: number;
}

const DO_PROMPT =
	'Do this workspace ticket: {{ticket.title}}\n\n' +
	'Execute the spec and plan below. When the plan is detailed, follow it as written — make the ' +
	'changes each step describes, verify each step as it specifies, and do not redesign it. If ' +
	'something is genuinely missing or impossible, stop and ask rather than improvising.\n\n' +
	'Ticket ID: {{ticket.id}}\n\n{{ticket.body}}\n\nPlan:\n{{ticket.plan}}\n\n' +
	'When done, review your own work before stopping: re-read the diff for correctness and ' +
	'regressions, confirm every acceptance criterion in the spec, then report what you changed, ' +
	'how you verified it, and anything you skipped or left undone.';

const REFINE_PROMPT =
	'Refine this workspace ticket: {{ticket.title}}\n\n' +
	'Turn this ticket into a complete, self-contained spec and implementation plan that a later "Do" ' +
	'run can execute without making any decisions. You are the strong model doing the thinking up front; ' +
	'the executor that follows may be much weaker, so resolve everything now and leave nothing to infer.\n\n' +
	'Write both artifacts into the ticket with `ticket_update` (id {{ticket.id}}), keeping any important ' +
	'details from the current body:\n\n' +
	'1. Spec (ticket body) — goal, verifiable acceptance criteria, requirements and edge cases, explicit ' +
	'in/out of scope, constraints, and every decision with its rationale. No open questions left.\n\n' +
	'2. Plan (ticket plan) — an ordered, dependency-sorted checklist of small, independently verifiable ' +
	'steps: file paths, symbols, the exact change, and how to verify each. The executor should only follow ' +
	'it, not design it.\n\n' +
	'Research the code first so file paths and approaches are accurate. Ask me the questions needed to drive ' +
	'each open decision to a concrete choice. Do not implement anything — refine only writes the spec and plan.' +
	'\n\nWrite both artifacts tight:\n' +
	'- Bullets and fragments, not full-sentence prose. No filler; never restate the ticket title or ID.\n' +
	"- Include a section only if it carries new information; skip or merge ones that don't apply.\n" +
	'- One line per decision; give rationale only when the choice is non-obvious — one sentence of ' +
	'rationale is a paragraph.\n' +
	'- Every path, symbol, and verification step stays exact; terse wording never cuts content.\n' +
	'- Match depth to the ticket: small change → tight spec and short checklist, not a padded one.\n\n' +
	'Ticket ID: {{ticket.id}}\n\n{{ticket.body}}\n\nPlan:\n{{ticket.plan}}';

export const TICKET_ACTION_DEFAULTS: readonly TicketActionDefault[] = [
	{
		key: 'do',
		title: 'Do',
		description: 'Start an implementation chat for the ticket.',
		prompt: DO_PROMPT,
		launchBehavior: 'send',
		conversationMode: null,
		approvalMode: null,
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
		approvalMode: null,
		model: null,
		pinned: true,
		orderIndex: 20
	},
	{
		key: 'refine',
		title: 'Refine',
		description:
			'Refine the ticket into a full spec and executable plan (interactive, no implementation).',
		prompt: REFINE_PROMPT,
		launchBehavior: 'send',
		conversationMode: 'interactive',
		approvalMode: null,
		model: null,
		pinned: true,
		orderIndex: 30
	}
];

/** Placeholder values for interpolating a ticket-action prompt. */
export function ticketPlaceholderValues(
	ticket: Pick<WorkspaceTicket, 'id' | 'title' | 'body' | 'plan'>
): Record<string, string> {
	return {
		'ticket.title': ticket.title,
		'ticket.id': String(ticket.id),
		'ticket.body': ticket.body.trim(),
		'ticket.plan': ticket.plan.trim() || '(none)'
	};
}
