import { ulid } from '../ids';
import { getDb } from '../index';
import {
	TICKET_ACTION_DEFAULTS,
	findUnknownPlaceholders,
	ticketActionDefaultId,
	unknownPlaceholderMessage,
	type TicketActionDefault
} from '$lib/prompt-templates';
import {
	normalizePromptTemplateType,
	normalizeSessionMode,
	normalizeTicketLaunchBehavior,
	type ChatPromptTemplate,
	type PromptTemplateStatus,
	type PromptTemplateType,
	type SessionMode,
	type TicketLaunchBehavior
} from '$lib/types';

interface PromptTemplateRow {
	id: string;
	user_id: string;
	type: string;
	title: string;
	description: string;
	prompt: string;
	launch_behavior: string | null;
	conversation_mode: string | null;
	status: string;
	pinned: number;
	order_index: number;
	created_at: number;
	updated_at: number;
	archived_at: number | null;
}

function normalizeStatus(raw: string): PromptTemplateStatus {
	return raw === 'archived' ? 'archived' : 'open';
}

function rowToTemplate(row: PromptTemplateRow): ChatPromptTemplate {
	const type = normalizePromptTemplateType(row.type);
	return {
		id: row.id,
		userId: row.user_id,
		type,
		title: row.title,
		description: row.description,
		prompt: row.prompt,
		launchBehavior:
			type === 'ticket-action' ? normalizeTicketLaunchBehavior(row.launch_behavior) : null,
		conversationMode:
			type === 'ticket-action' && row.conversation_mode
				? normalizeSessionMode(row.conversation_mode)
				: null,
		status: normalizeStatus(row.status),
		pinned: row.pinned === 1,
		orderIndex: row.order_index,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		archivedAt: row.archived_at
	};
}

/** Throws on unknown `{{placeholders}}` for the given type. */
function assertPlaceholders(prompt: string, type: PromptTemplateType): void {
	const unknown = findUnknownPlaceholders(prompt, type);
	if (unknown.length > 0) {
		throw new Error(unknownPlaceholderMessage(type, unknown));
	}
}

export interface ListOptions {
	status?: PromptTemplateStatus | 'all';
	type?: PromptTemplateType;
	limit?: number;
}

export function list(userId: string, opts: ListOptions = {}): ChatPromptTemplate[] {
	const status = opts.status ?? 'open';
	const limit = opts.limit ?? 100;
	const filters: string[] = ['user_id = ?'];
	const args: (string | number)[] = [userId];
	if (opts.type) {
		filters.push('type = ?');
		args.push(opts.type);
	}
	if (status !== 'all') {
		filters.push('status = ?');
		args.push(status);
	}
	const order =
		status === 'all'
			? "status = 'open' DESC, pinned DESC, order_index ASC, updated_at DESC"
			: 'pinned DESC, order_index ASC, updated_at DESC';
	args.push(limit);
	const rows = getDb()
		.prepare(
			`SELECT * FROM prompt_templates
			 WHERE ${filters.join(' AND ')}
			 ORDER BY ${order}
			 LIMIT ?`
		)
		.all(...args) as PromptTemplateRow[];
	return rows.map(rowToTemplate);
}

export function get(id: string, userId: string): ChatPromptTemplate | null {
	const row = getDb()
		.prepare('SELECT * FROM prompt_templates WHERE id = ? AND user_id = ?')
		.get(id, userId) as PromptTemplateRow | undefined;
	return row ? rowToTemplate(row) : null;
}

export interface CreateInput {
	id?: string;
	type?: PromptTemplateType;
	title: string;
	description?: string;
	prompt: string;
	launchBehavior?: TicketLaunchBehavior | null;
	conversationMode?: SessionMode | null;
	pinned?: boolean;
	orderIndex?: number;
}

export function create(userId: string, input: CreateInput): ChatPromptTemplate {
	const type = input.type ?? 'chat';
	const title = input.title.trim();
	const description = input.description?.trim() ?? '';
	const prompt = input.prompt.trim();
	if (!title) throw new Error('prompt template title cannot be empty');
	if (!prompt) throw new Error('prompt template body cannot be empty');
	assertPlaceholders(prompt, type);
	const launchBehavior = type === 'ticket-action' ? (input.launchBehavior ?? 'send') : null;
	const conversationMode = type === 'ticket-action' ? (input.conversationMode ?? null) : null;
	const id = input.id ?? ulid();
	const now = Date.now();
	const orderIndex = Number.isFinite(input.orderIndex) ? Math.trunc(input.orderIndex ?? 0) : 0;
	getDb()
		.prepare(
			`INSERT INTO prompt_templates(
			   id, user_id, type, title, description, prompt, launch_behavior, conversation_mode,
			   status, pinned, order_index, created_at, updated_at, archived_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, NULL)`
		)
		.run(
			id,
			userId,
			type,
			title,
			description,
			prompt,
			launchBehavior,
			conversationMode,
			input.pinned ? 1 : 0,
			orderIndex,
			now,
			now
		);
	return {
		id,
		userId,
		type,
		title,
		description,
		prompt,
		launchBehavior,
		conversationMode,
		status: 'open',
		pinned: input.pinned ?? false,
		orderIndex,
		createdAt: now,
		updatedAt: now,
		archivedAt: null
	};
}

export interface UpdateInput {
	title?: string;
	description?: string;
	prompt?: string;
	launchBehavior?: TicketLaunchBehavior | null;
	conversationMode?: SessionMode | null;
	status?: PromptTemplateStatus;
	pinned?: boolean;
	orderIndex?: number;
}

export function update(id: string, userId: string, patch: UpdateInput): ChatPromptTemplate | null {
	const current = get(id, userId);
	if (!current) return null;

	const title = patch.title?.trim();
	const prompt = patch.prompt?.trim();
	if (title !== undefined && !title) throw new Error('prompt template title cannot be empty');
	if (prompt !== undefined && !prompt) throw new Error('prompt template body cannot be empty');
	if (prompt !== undefined) assertPlaceholders(prompt, current.type);
	const nextStatus = patch.status ?? current.status;
	const now = Date.now();
	const archivedAt = nextStatus === 'archived' ? (current.archivedAt ?? now) : null;
	const orderIndex =
		patch.orderIndex !== undefined && Number.isFinite(patch.orderIndex)
			? Math.trunc(patch.orderIndex)
			: current.orderIndex;
	const launchBehavior =
		current.type === 'ticket-action'
			? patch.launchBehavior !== undefined
				? patch.launchBehavior
				: current.launchBehavior
			: null;
	const conversationMode =
		current.type === 'ticket-action'
			? patch.conversationMode !== undefined
				? patch.conversationMode
				: current.conversationMode
			: null;

	getDb()
		.prepare(
			`UPDATE prompt_templates
			 SET title = ?, description = ?, prompt = ?, launch_behavior = ?, conversation_mode = ?,
			     status = ?, pinned = ?, order_index = ?, updated_at = ?, archived_at = ?
			 WHERE id = ? AND user_id = ?`
		)
		.run(
			title ?? current.title,
			patch.description?.trim() ?? current.description,
			prompt ?? current.prompt,
			launchBehavior,
			conversationMode,
			nextStatus,
			(patch.pinned ?? current.pinned) ? 1 : 0,
			orderIndex,
			now,
			archivedAt,
			id,
			userId
		);
	return get(id, userId);
}

export function archive(id: string, userId: string): ChatPromptTemplate | null {
	return update(id, userId, { status: 'archived' });
}

// ---------------------------------------------------------------------------
// Ticket-action default seeding
// ---------------------------------------------------------------------------

function insertDefault(userId: string, def: TicketActionDefault): void {
	create(userId, {
		id: ticketActionDefaultId(userId, def.key),
		type: 'ticket-action',
		title: def.title,
		description: def.description,
		prompt: def.prompt,
		launchBehavior: def.launchBehavior,
		conversationMode: def.conversationMode,
		pinned: def.pinned,
		orderIndex: def.orderIndex
	});
}

function countTicketActions(userId: string): number {
	const row = getDb()
		.prepare(
			"SELECT COUNT(*) AS n FROM prompt_templates WHERE user_id = ? AND type = 'ticket-action'"
		)
		.get(userId) as { n: number };
	return row.n;
}

/**
 * Lazy-seed the Do/Draft/Refine defaults the first time a user has zero
 * ticket-action templates (of any status). Archived defaults still count, so a
 * user who deliberately removed every action isn't re-seeded on the next load.
 */
export function ensureTicketActionDefaults(userId: string): void {
	if (countTicketActions(userId) > 0) return;
	const tx = getDb().transaction(() => {
		for (const def of TICKET_ACTION_DEFAULTS) insertDefault(userId, def);
	});
	tx();
}

/**
 * Re-add any missing default actions (and un-archive removed ones) without
 * clobbering still-open user edits. Powers the "Restore defaults" button.
 * Returns the number of defaults (re)added.
 */
export function restoreTicketActionDefaults(userId: string): number {
	let restored = 0;
	const tx = getDb().transaction(() => {
		for (const def of TICKET_ACTION_DEFAULTS) {
			const id = ticketActionDefaultId(userId, def.key);
			const existing = get(id, userId);
			if (!existing) {
				insertDefault(userId, def);
				restored += 1;
			} else if (existing.status === 'archived') {
				update(id, userId, { status: 'open' });
				restored += 1;
			}
		}
	});
	tx();
	return restored;
}
