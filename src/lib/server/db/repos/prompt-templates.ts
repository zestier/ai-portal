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
	normalizeLaunchBehavior,
	normalizePromptTemplateType,
	normalizePromptTemplateWorkspaceMode,
	normalizeSessionMode,
	type ChatPromptTemplate,
	type PromptLaunchBehavior,
	type PromptTemplateStatus,
	type PromptTemplateType,
	type PromptTemplateWorkspaceMode,
	type SessionMode
} from '$lib/types';
import { sanitizeDisabledToolGroups, type PortalToolGroupId } from '$lib/tools/groups';

interface PromptTemplateRow {
	id: string;
	user_id: string;
	type: string;
	title: string;
	description: string;
	prompt: string;
	launch_behavior: string | null;
	conversation_mode: string | null;
	model: string | null;
	disabled_tool_groups: string | null;
	workspace_mode: string | null;
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

/** Trim a model override, collapsing empty/whitespace to `null` (use default). */
function normalizeModelOverride(raw: string | null | undefined): string | null {
	const trimmed = raw?.trim();
	return trimmed ? trimmed : null;
}

/** Parse the `disabled_tool_groups` JSON column into a validated id list. */
function parseDisabledToolGroups(raw: string | null): PortalToolGroupId[] {
	if (!raw) return [];
	try {
		return sanitizeDisabledToolGroups(JSON.parse(raw));
	} catch {
		return [];
	}
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
		launchBehavior: normalizeLaunchBehavior(row.launch_behavior, type),
		conversationMode: row.conversation_mode ? normalizeSessionMode(row.conversation_mode) : null,
		model: row.model ?? null,
		disabledToolGroups: type === 'chat' ? parseDisabledToolGroups(row.disabled_tool_groups) : [],
		workspaceMode: normalizePromptTemplateWorkspaceMode(row.workspace_mode),
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
	launchBehavior?: PromptLaunchBehavior | null;
	conversationMode?: SessionMode | null;
	model?: string | null;
	disabledToolGroups?: string[];
	workspaceMode?: PromptTemplateWorkspaceMode | null;
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
	const launchBehavior = normalizeLaunchBehavior(input.launchBehavior, type);
	const conversationMode = input.conversationMode ?? null;
	const model = normalizeModelOverride(input.model);
	const disabledToolGroups =
		type === 'chat' ? sanitizeDisabledToolGroups(input.disabledToolGroups) : [];
	const workspaceMode = normalizePromptTemplateWorkspaceMode(input.workspaceMode);
	const id = input.id ?? ulid();
	const now = Date.now();
	const orderIndex = Number.isFinite(input.orderIndex) ? Math.trunc(input.orderIndex ?? 0) : 0;
	getDb()
		.prepare(
			`INSERT INTO prompt_templates(
			   id, user_id, type, title, description, prompt, launch_behavior, conversation_mode,
			   model, disabled_tool_groups, workspace_mode, status, pinned, order_index,
			   created_at, updated_at, archived_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, NULL)`
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
			model,
			JSON.stringify(disabledToolGroups),
			workspaceMode,
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
		model,
		disabledToolGroups,
		workspaceMode,
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
	launchBehavior?: PromptLaunchBehavior | null;
	conversationMode?: SessionMode | null;
	model?: string | null;
	disabledToolGroups?: string[];
	workspaceMode?: PromptTemplateWorkspaceMode | null;
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
		patch.launchBehavior !== undefined
			? normalizeLaunchBehavior(patch.launchBehavior, current.type)
			: current.launchBehavior;
	const conversationMode =
		patch.conversationMode !== undefined ? patch.conversationMode : current.conversationMode;
	const model = patch.model !== undefined ? normalizeModelOverride(patch.model) : current.model;
	const disabledToolGroups =
		current.type === 'chat'
			? patch.disabledToolGroups !== undefined
				? sanitizeDisabledToolGroups(patch.disabledToolGroups)
				: current.disabledToolGroups
			: [];
	const workspaceMode =
		patch.workspaceMode !== undefined
			? normalizePromptTemplateWorkspaceMode(patch.workspaceMode)
			: current.workspaceMode;

	getDb()
		.prepare(
			`UPDATE prompt_templates
			 SET title = ?, description = ?, prompt = ?, launch_behavior = ?, conversation_mode = ?,
			     model = ?, disabled_tool_groups = ?, workspace_mode = ?, status = ?, pinned = ?,
			     order_index = ?,
			     updated_at = ?, archived_at = ?
			 WHERE id = ? AND user_id = ?`
		)
		.run(
			title ?? current.title,
			patch.description?.trim() ?? current.description,
			prompt ?? current.prompt,
			launchBehavior,
			conversationMode,
			model,
			JSON.stringify(disabledToolGroups),
			workspaceMode,
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
		model: def.model,
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
 * Re-add any missing default actions, un-archive removed ones, and reset the
 * canonical fields (prompt, title, description, launchBehavior, conversationMode)
 * of existing defaults to the current built-in values. Powers the "Restore
 * defaults" button. Returns the number of defaults (re)added or updated.
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
			} else {
				update(id, userId, {
					status: 'open',
					title: def.title,
					description: def.description,
					prompt: def.prompt,
					launchBehavior: def.launchBehavior,
					conversationMode: def.conversationMode
				});
				restored += 1;
			}
		}
	});
	tx();
	return restored;
}
