import type {
	ChatPromptTemplate,
	PromptTemplateType,
	SessionMode,
	TicketLaunchBehavior,
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
		launchBehavior: null,
		conversationMode: null,
		model: null,
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
		launchBehavior: null,
		conversationMode: null,
		model: null,
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
		launchBehavior: null,
		conversationMode: null,
		model: null,
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
		launchBehavior: null,
		conversationMode: null,
		model: null,
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
// Ticket-action defaults (seeded Do / Draft / Refine)
// ---------------------------------------------------------------------------

export interface TicketActionDefault {
	key: 'do' | 'draft' | 'refine';
	title: string;
	description: string;
	prompt: string;
	launchBehavior: TicketLaunchBehavior;
	conversationMode: SessionMode | null;
	/** Optional model override; `null` keeps the user's default model. */
	model: string | null;
	pinned: boolean;
	orderIndex: number;
}

const DO_PROMPT =
	'Do this workspace ticket: {{ticket.title}}\n\nTicket ID: {{ticket.id}}\n\n{{ticket.body}}';

const REFINE_PROMPT =
	'Refine this workspace ticket: {{ticket.title}}\n\n' +
	'Clarify the request, acceptance criteria, scope, risks, and useful implementation notes. ' +
	'Research the code if needed. Ask me the questions required to flesh out the ticket, driving ' +
	'each open decision to a concrete choice rather than leaving it ambiguous. Record those ' +
	'decisions in the ticket. Update the ticket instead of implementing it unless explicitly asked.' +
	'\n\nTicket ID: {{ticket.id}}\n\n{{ticket.body}}';

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
		'ticket.plan': ticket.plan.trim()
	};
}
