import { getDb } from '../index';
import { promptTemplateId } from '$lib/ids';
import {
	TICKET_ACTION_DEFAULTS,
	findUnknownPlaceholders,
	unknownPlaceholderMessage,
	type TicketActionDefault
} from '$lib/prompt-templates';
import {
	normalizeApprovalMode,
	normalizeLaunchBehavior,
	normalizePromptTemplateType,
	normalizePromptTemplateWorkspaceMode,
	normalizeSessionMode,
	type ApprovalMode,
	type ChatPromptTemplate,
	type PromptLaunchBehavior,
	type PromptTemplateStatus,
	type PromptTemplateType,
	type PromptTemplateWorkspaceMode,
	type SessionMode
} from '$lib/types';
import { sanitizeDisabledToolGroups, type PortalToolGroupId } from '$lib/tools/groups';

interface PromptTemplateRow {
	id: number;
	user_id: number;
	type: string;
	title: string;
	description: string;
	prompt: string;
	system_prompt: string | null;
	append_system_prompt: string | null;
	launch_behavior: string | null;
	conversation_mode: string | null;
	approval_mode: string | null;
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

/** Trim an optional text override, collapsing empty/whitespace to `null` (unset). */
function normalizeOptionalText(raw: string | null | undefined): string | null {
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
		id: promptTemplateId.encode(row.id),
		userId: row.user_id,
		type,
		title: row.title,
		description: row.description,
		prompt: row.prompt,
		systemPrompt: row.system_prompt ?? null,
		appendSystemPrompt: row.append_system_prompt ?? null,
		launchBehavior: normalizeLaunchBehavior(row.launch_behavior, type),
		conversationMode: row.conversation_mode ? normalizeSessionMode(row.conversation_mode) : null,
		approvalMode: row.approval_mode ? normalizeApprovalMode(row.approval_mode) : null,
		model: row.model ?? null,
		disabledToolGroups: parseDisabledToolGroups(row.disabled_tool_groups),
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

export function list(userId: number, opts: ListOptions = {}): ChatPromptTemplate[] {
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

function templateInt(id: string | number): number {
	return typeof id === 'number' ? id : promptTemplateId.parse(id);
}

export function get(id: string | number, userId: number): ChatPromptTemplate | null {
	const row = getDb()
		.prepare('SELECT * FROM prompt_templates WHERE id = ? AND user_id = ?')
		.get(templateInt(id), userId) as PromptTemplateRow | undefined;
	return row ? rowToTemplate(row) : null;
}

export interface CreateInput {
	type?: PromptTemplateType;
	title: string;
	description?: string;
	prompt: string;
	systemPrompt?: string | null;
	appendSystemPrompt?: string | null;
	launchBehavior?: PromptLaunchBehavior | null;
	conversationMode?: SessionMode | null;
	approvalMode?: ApprovalMode | null;
	model?: string | null;
	disabledToolGroups?: string[];
	workspaceMode?: PromptTemplateWorkspaceMode | null;
	pinned?: boolean;
	orderIndex?: number;
}

export function create(userId: number, input: CreateInput): ChatPromptTemplate {
	const type = input.type ?? 'chat';
	const title = input.title.trim();
	const description = input.description?.trim() ?? '';
	const prompt = input.prompt.trim();
	const systemPrompt = normalizeOptionalText(input.systemPrompt);
	const appendSystemPrompt = normalizeOptionalText(input.appendSystemPrompt);
	if (!title) throw new Error('prompt template title cannot be empty');
	if (!prompt) throw new Error('prompt template body cannot be empty');
	assertPlaceholders(prompt, type);
	const launchBehavior = normalizeLaunchBehavior(input.launchBehavior, type);
	const conversationMode = input.conversationMode ?? null;
	const approvalMode = input.approvalMode ?? null;
	const model = normalizeModelOverride(input.model);
	const disabledToolGroups = sanitizeDisabledToolGroups(input.disabledToolGroups);
	const workspaceMode = normalizePromptTemplateWorkspaceMode(input.workspaceMode);
	const now = Date.now();
	const orderIndex = Number.isFinite(input.orderIndex) ? Math.trunc(input.orderIndex ?? 0) : 0;
	const id = Number(
		getDb()
			.prepare(
				`INSERT INTO prompt_templates(
				   user_id, type, title, description, prompt, system_prompt, append_system_prompt,
				   launch_behavior, conversation_mode, approval_mode, model, disabled_tool_groups,
				   workspace_mode, status, pinned, order_index, created_at, updated_at, archived_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, NULL)`
			)
			.run(
				userId,
				type,
				title,
				description,
				prompt,
				systemPrompt,
				appendSystemPrompt,
				launchBehavior,
				conversationMode,
				approvalMode,
				model,
				JSON.stringify(disabledToolGroups),
				workspaceMode,
				input.pinned ? 1 : 0,
				orderIndex,
				now,
				now
			).lastInsertRowid
	);
	return {
		id: promptTemplateId.encode(id),
		userId,
		type,
		title,
		description,
		prompt,
		systemPrompt,
		appendSystemPrompt,
		launchBehavior,
		conversationMode,
		approvalMode,
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
	systemPrompt?: string | null;
	appendSystemPrompt?: string | null;
	launchBehavior?: PromptLaunchBehavior | null;
	conversationMode?: SessionMode | null;
	approvalMode?: ApprovalMode | null;
	model?: string | null;
	disabledToolGroups?: string[];
	workspaceMode?: PromptTemplateWorkspaceMode | null;
	status?: PromptTemplateStatus;
	pinned?: boolean;
	orderIndex?: number;
}

export function update(
	id: string | number,
	userId: number,
	patch: UpdateInput
): ChatPromptTemplate | null {
	const intId = templateInt(id);
	const current = get(intId, userId);
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
	const approvalMode = patch.approvalMode !== undefined ? patch.approvalMode : current.approvalMode;
	const model = patch.model !== undefined ? normalizeModelOverride(patch.model) : current.model;
	const systemPrompt =
		patch.systemPrompt !== undefined
			? normalizeOptionalText(patch.systemPrompt)
			: (current.systemPrompt ?? null);
	const appendSystemPrompt =
		patch.appendSystemPrompt !== undefined
			? normalizeOptionalText(patch.appendSystemPrompt)
			: (current.appendSystemPrompt ?? null);
	const disabledToolGroups =
		patch.disabledToolGroups !== undefined
			? sanitizeDisabledToolGroups(patch.disabledToolGroups)
			: current.disabledToolGroups;
	const workspaceMode =
		patch.workspaceMode !== undefined
			? normalizePromptTemplateWorkspaceMode(patch.workspaceMode)
			: current.workspaceMode;

	getDb()
		.prepare(
			`UPDATE prompt_templates
			 SET title = ?, description = ?, prompt = ?, system_prompt = ?, append_system_prompt = ?,
			     launch_behavior = ?, conversation_mode = ?,
			     approval_mode = ?, model = ?, disabled_tool_groups = ?, workspace_mode = ?, status = ?,
			     pinned = ?, order_index = ?,
			     updated_at = ?, archived_at = ?
			 WHERE id = ? AND user_id = ?`
		)
		.run(
			title ?? current.title,
			patch.description?.trim() ?? current.description,
			prompt ?? current.prompt,
			systemPrompt,
			appendSystemPrompt,
			launchBehavior,
			conversationMode,
			approvalMode,
			model,
			JSON.stringify(disabledToolGroups),
			workspaceMode,
			nextStatus,
			(patch.pinned ?? current.pinned) ? 1 : 0,
			orderIndex,
			now,
			archivedAt,
			intId,
			userId
		);
	return get(intId, userId);
}

export function archive(id: string | number, userId: number): ChatPromptTemplate | null {
	return update(id, userId, { status: 'archived' });
}

// ---------------------------------------------------------------------------
// Ticket-action default seeding
// ---------------------------------------------------------------------------

function insertDefault(userId: number, def: TicketActionDefault): void {
	create(userId, {
		type: 'ticket-action',
		title: def.title,
		description: def.description,
		prompt: def.prompt,
		launchBehavior: def.launchBehavior,
		conversationMode: def.conversationMode,
		approvalMode: def.approvalMode,
		model: def.model,
		pinned: def.pinned,
		orderIndex: def.orderIndex
	});
}

function countTicketActions(userId: number): number {
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
export function ensureTicketActionDefaults(userId: number): void {
	if (countTicketActions(userId) > 0) return;
	const tx = getDb().transaction(() => {
		for (const def of TICKET_ACTION_DEFAULTS) insertDefault(userId, def);
	});
	tx();
}

// Seeded defaults are identified by their canonical title (Do/Draft/Refine are
// distinct). Ids are now DB-minted integers, so the old deterministic id scheme
// (`<userId>__tia_<key>`) no longer applies; a user who renames a default before
// hitting "Restore defaults" gets a fresh copy rather than a field reset.
function findDefaultByTitle(userId: number, title: string): ChatPromptTemplate | null {
	const row = getDb()
		.prepare(
			`SELECT * FROM prompt_templates
			  WHERE user_id = ? AND type = 'ticket-action' AND title = ?
			  ORDER BY created_at ASC LIMIT 1`
		)
		.get(userId, title) as PromptTemplateRow | undefined;
	return row ? rowToTemplate(row) : null;
}

/**
 * Re-add any missing default actions, un-archive removed ones, and reset the
 * canonical fields (prompt, title, description, launchBehavior,
 * conversationMode, approvalMode)
 * of existing defaults to the current built-in values. Powers the "Restore
 * defaults" button. Returns the number of defaults (re)added or updated.
 */
export function restoreTicketActionDefaults(userId: number): number {
	let restored = 0;
	const tx = getDb().transaction(() => {
		for (const def of TICKET_ACTION_DEFAULTS) {
			const existing = findDefaultByTitle(userId, def.title);
			if (!existing) {
				insertDefault(userId, def);
				restored += 1;
			} else {
				update(promptTemplateId.parse(existing.id), userId, {
					status: 'open',
					title: def.title,
					description: def.description,
					prompt: def.prompt,
					launchBehavior: def.launchBehavior,
					conversationMode: def.conversationMode,
					approvalMode: def.approvalMode
				});
				restored += 1;
			}
		}
	});
	tx();
	return restored;
}
