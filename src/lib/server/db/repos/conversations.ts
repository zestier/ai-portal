import { getDb } from '../index';
import { purgeSessionSearchIndex } from './memory';
import { conversationId, messageId } from '$lib/ids';
import {
	normalizeApprovalMode,
	normalizeMemoryMode,
	normalizeSessionMode,
	type ApprovalMode,
	type Conversation,
	type MemoryMode,
	type SessionMode,
	type WorkspaceKind
} from '$lib/types';
import type { ManagedWorktreeMetadata } from '../../worktrees';
import { effectiveWorkdir } from '../../workdir';
import { sanitizeDisabledToolGroups, type PortalToolGroupId } from '$lib/tools/groups';

/**
 * Parse the `disabled_tool_groups` JSON column into a validated id list.
 * Tolerates NULL/legacy/garbage values (returns [] = all groups enabled) and
 * drops any ids that are no longer recognized.
 */
function parseDisabledToolGroups(raw: string | null): PortalToolGroupId[] {
	if (!raw) return [];
	try {
		return sanitizeDisabledToolGroups(JSON.parse(raw));
	} catch {
		return [];
	}
}

interface ConvRow {
	id: number;
	user_id: number;
	title: string;
	workdir: string;
	model: string | null;
	session_file: string | null;
	created_at: number;
	updated_at: number;
	archived_at: number | null;
	forked_from_conversation_id: number | null;
	forked_from_message_id: number | null;
	mode: string | null;
	memory_mode: string | null;
	memory_extractor_model: string | null;
	adversary_model: string | null;
	global_memory_enabled: number | null;
	approval_mode: string | null;
	disabled_tool_groups: string | null;
	draft_prompt: string | null;
	workspace_kind: WorkspaceKind;
	workspace_key: string | null;
	system_prompt: string | null;
	append_system_prompt: string | null;
	worktree_branch: string | null;
	worktree_base_sha: string | null;
}

// Correlated-EXISTS predicate over an outer `conversations c`: true when the
// conversation carries assistant output newer than the user's last read. Only
// `assistant` rows count (the user's own messages are seen by definition, and
// system/tool rows aren't a response worth flagging); a NULL `last_read_at`
// means "never read". Shared by the set and single-row queries so the two can't
// drift. Served by `idx_messages_conv_created`.
const HAS_UNSEEN_ASSISTANT = `EXISTS (
	          SELECT 1 FROM messages m
	           WHERE m.conversation_id = c.id
	             AND m.role = 'assistant'
	             AND m.created_at > COALESCE(c.last_read_at, 0)
	        )`;

const CONVERSATION_SELECT = `
	SELECT conversations.*,
	       (SELECT branch FROM managed_worktrees WHERE conversation_id = conversations.id)
	         AS worktree_branch,
	       (SELECT base_sha FROM managed_worktrees WHERE conversation_id = conversations.id)
	         AS worktree_base_sha
	  FROM conversations`;

function rowToConv(r: ConvRow): Conversation {
	const mode = normalizeSessionMode(r.mode);
	return {
		id: conversationId.encode(r.id),
		userId: r.user_id,
		title: r.title,
		workdir: r.workdir,
		model: r.model,
		sessionFile: r.session_file ?? null,
		mode,
		memoryMode: normalizeMemoryMode(r.memory_mode),
		memoryExtractorModel: r.memory_extractor_model ?? null,
		adversaryModel: r.adversary_model ?? null,
		globalMemoryEnabled: r.global_memory_enabled === 1,
		approvalMode: normalizeApprovalMode(r.approval_mode),
		disabledToolGroups: parseDisabledToolGroups(r.disabled_tool_groups),
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		archivedAt: r.archived_at,
		forkedFromConversationId:
			r.forked_from_conversation_id === null
				? null
				: conversationId.encode(r.forked_from_conversation_id),
		forkedFromMessageId:
			r.forked_from_message_id === null ? null : messageId.encode(r.forked_from_message_id),
		draftPrompt: r.draft_prompt ?? null,
		workspaceKind: r.workspace_kind ?? 'shared',
		workspaceKey: r.workspace_key ?? effectiveWorkdir(r.workdir),
		systemPrompt: r.system_prompt ?? null,
		appendSystemPrompt: r.append_system_prompt ?? null,
		worktreeBranch: r.worktree_branch ?? null,
		worktreeBaseSha: r.worktree_base_sha ?? null
	};
}

// Resolve a conversation-id argument to its storage int. Repo inputs accept
// both raw ints and the opaque C-handle (handles parse here); the SQL layer
// only ever sees ints.
function convInt(id: string | number): number {
	return typeof id === 'number' ? id : conversationId.parse(id);
}

export function get(id: string | number, userId: number): Conversation | null {
	const intId = convInt(id);
	const r = getDb()
		.prepare(`${CONVERSATION_SELECT} WHERE conversations.id = ? AND conversations.user_id = ?`)
		.get(intId, userId) as ConvRow | undefined;
	return r ? rowToConv(r) : null;
}

export interface ListOpts {
	includeArchived?: boolean;
	limit?: number;
}

/**
 * List conversations that were forked from `sourceId` (i.e., child forks).
 * Scoped to `userId` so users only ever see their own forks; the source
 * conversation must also be theirs at the call site.
 */
export function listChildren(userId: number, sourceId: string | number): Conversation[] {
	const rows = getDb()
		.prepare(
			`${CONVERSATION_SELECT}
			 WHERE conversations.user_id = ? AND conversations.forked_from_conversation_id = ?
			 ORDER BY created_at ASC`
		)
		.all(userId, convInt(sourceId)) as ConvRow[];
	return rows.map(rowToConv);
}

export function list(userId: number, opts: ListOpts = {}): Conversation[] {
	const limit = opts.limit ?? 200;
	const sql = opts.includeArchived
		? `${CONVERSATION_SELECT} WHERE conversations.user_id = ? ORDER BY updated_at DESC LIMIT ?`
		: `${CONVERSATION_SELECT} WHERE conversations.user_id = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT ?`;
	const rows = getDb().prepare(sql).all(userId, limit) as ConvRow[];
	return rows.map(rowToConv);
}

export interface CreateInput {
	title: string;
	workdir: string;
	model: string | null;
	mode?: SessionMode;
	approvalMode?: ApprovalMode;
	memoryMode?: MemoryMode;
	memoryExtractorModel?: string | null;
	adversaryModel?: string | null;
	globalMemoryEnabled?: boolean;
	disabledToolGroups?: string[];
	forkedFromConversationId?: number | null;
	forkedFromMessageId?: number | null;
	draftPrompt?: string | null;
	workspaceKind?: WorkspaceKind;
	workspaceKey?: string;
	managedWorktree?: ManagedWorktreeMetadata;
	systemPrompt?: string | null;
	appendSystemPrompt?: string | null;
}

/**
 * Mint a fresh conversation id without touching the database. Useful when
 * the caller needs the id to derive other state (e.g. workdir path) before
 * inserting the row.
 */
export function create(userId: number, input: CreateInput): Conversation {
	const now = Date.now();
	const forkConv = input.forkedFromConversationId ?? null;
	const forkMsg = input.forkedFromMessageId ?? null;
	const mode = input.mode ?? 'interactive';
	const approvalMode = normalizeApprovalMode(input.approvalMode);
	const memoryMode = input.memoryMode ?? 'off';
	const memoryExtractorModel = normalizeOptionalModel(input.memoryExtractorModel);
	const adversaryModel = normalizeOptionalModel(input.adversaryModel);
	const globalMemoryEnabled = input.globalMemoryEnabled === true;
	const disabledToolGroups = sanitizeDisabledToolGroups(input.disabledToolGroups);
	const draftPrompt = input.draftPrompt ?? null;
	const workspaceKind = input.workspaceKind ?? 'shared';
	const workspaceKey = input.workspaceKey ?? effectiveWorkdir(input.workdir);
	const systemPrompt = input.systemPrompt?.trim() ? input.systemPrompt.trim() : null;
	const appendSystemPrompt = input.appendSystemPrompt?.trim()
		? input.appendSystemPrompt.trim()
		: null;
	const db = getDb();
	let id = 0;
	db.transaction(() => {
		const info = db
			.prepare(
				`INSERT INTO conversations(
				   user_id, title, workdir, model, mode, approval_mode, memory_mode, memory_extractor_model,
				   adversary_model, global_memory_enabled, disabled_tool_groups, created_at, updated_at,
				   forked_from_conversation_id, forked_from_message_id, draft_prompt,
				   workspace_kind, workspace_key, system_prompt, append_system_prompt
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				userId,
				input.title,
				input.workdir,
				input.model,
				mode,
				approvalMode,
				memoryMode,
				memoryExtractorModel,
				adversaryModel,
				globalMemoryEnabled ? 1 : 0,
				JSON.stringify(disabledToolGroups),
				now,
				now,
				forkConv,
				forkMsg,
				draftPrompt,
				workspaceKind,
				workspaceKey,
				systemPrompt,
				appendSystemPrompt
			);
		id = Number(info.lastInsertRowid);
		if (workspaceKind === 'managed-worktree') {
			if (!input.managedWorktree) {
				throw new Error('managed-worktree conversation requires managedWorktree metadata');
			}
			const worktree = input.managedWorktree;
			db.prepare(
				`INSERT INTO managed_worktrees(
				   conversation_id, source_workdir, path, git_common_dir, branch, base_sha, created_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?)`
			).run(
				id,
				worktree.sourceWorkdir,
				worktree.path,
				worktree.gitCommonDir,
				worktree.branch,
				worktree.baseSha,
				now
			);
		}
	})();
	return {
		id: conversationId.encode(id),
		userId,
		title: input.title,
		workdir: input.workdir,
		model: input.model,
		sessionFile: null,
		mode,
		memoryMode,
		memoryExtractorModel,
		adversaryModel,
		globalMemoryEnabled,
		approvalMode,
		disabledToolGroups,
		createdAt: now,
		updatedAt: now,
		archivedAt: null,
		forkedFromConversationId: forkConv === null ? null : conversationId.encode(forkConv),
		forkedFromMessageId: forkMsg === null ? null : messageId.encode(forkMsg),
		draftPrompt,
		workspaceKind,
		workspaceKey,
		systemPrompt,
		appendSystemPrompt,
		worktreeBranch: input.managedWorktree?.branch ?? null,
		worktreeBaseSha: input.managedWorktree?.baseSha ?? null
	};
}

/**
 * Record (or replace) the managed-worktree row for a conversation. Used by the
 * fork flow, which creates the conversation row before the worktree exists and
 * fills in the metadata once the checkout is on disk. There is at most one such
 * row per conversation (`conversation_id` is the primary key).
 */
export function setManagedWorktree(id: string | number, worktree: ManagedWorktreeMetadata): void {
	const intId = convInt(id);
	getDb()
		.prepare(
			`INSERT INTO managed_worktrees(conversation_id, source_workdir, path, git_common_dir, branch, base_sha, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(conversation_id) DO UPDATE SET
			   source_workdir = excluded.source_workdir,
			   path = excluded.path,
			   git_common_dir = excluded.git_common_dir,
			   branch = excluded.branch,
			   base_sha = excluded.base_sha`
		)
		.run(
			intId,
			worktree.sourceWorkdir,
			worktree.path,
			worktree.gitCommonDir,
			worktree.branch,
			worktree.baseSha,
			Date.now()
		);
}

export function getManagedWorktree(
	id: string | number,
	userId: number
): ManagedWorktreeMetadata | null {
	const intId = convInt(id);
	const row = getDb()
		.prepare(
			`SELECT mw.source_workdir, mw.path, mw.git_common_dir, mw.branch, mw.base_sha
			   FROM managed_worktrees mw
			   JOIN conversations c ON c.id = mw.conversation_id
			  WHERE mw.conversation_id = ? AND c.user_id = ?`
		)
		.get(intId, userId) as
		| {
				source_workdir: string;
				path: string;
				git_common_dir: string;
				branch: string;
				base_sha: string;
		  }
		| undefined;
	return row
		? {
				sourceWorkdir: row.source_workdir,
				path: row.path,
				gitCommonDir: row.git_common_dir,
				branch: row.branch,
				baseSha: row.base_sha
			}
		: null;
}

export function rename(id: string | number, userId: number, title: string): boolean {
	const intId = convInt(id);
	const r = getDb()
		.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?')
		.run(title, Date.now(), intId, userId);
	return r.changes > 0;
}

export function renameIfDefault(id: string | number, userId: number, title: string): boolean {
	const intId = convInt(id);
	const r = getDb()
		.prepare(
			`UPDATE conversations
			    SET title = ?, updated_at = ?
			  WHERE id = ? AND user_id = ? AND (title = '' OR trim(title) = 'New chat')`
		)
		.run(title, Date.now(), intId, userId);
	return r.changes > 0;
}

/**
 * Update per-conversation session settings (model, mode, and/or approval mode).
 * Returns true iff a row was modified. The bridge reads these on each
 * `pool.acquire` so a recreated session inherits the latest values; the
 * /session PATCH endpoint additionally pushes them to the live SDK session
 * via `session.setMode` / `session.setApprovalMode` when supported.
 */
export function updateSessionSettings(
	id: string | number,
	userId: number,
	patch: {
		model?: string;
		mode?: SessionMode;
		memoryMode?: MemoryMode;
		memoryExtractorModel?: string | null;
		adversaryModel?: string | null;
		globalMemoryEnabled?: boolean;
		approvalMode?: ApprovalMode;
		disabledToolGroups?: string[];
	}
): boolean {
	const sets: string[] = [];
	const args: Array<string | number | null> = [];
	if (patch.model !== undefined) {
		sets.push('model = ?');
		args.push(patch.model);
	}
	if (patch.mode !== undefined) {
		sets.push('mode = ?');
		args.push(patch.mode);
	}
	if (patch.memoryMode !== undefined) {
		sets.push('memory_mode = ?');
		args.push(patch.memoryMode);
	}
	if (patch.memoryExtractorModel !== undefined) {
		sets.push('memory_extractor_model = ?');
		args.push(normalizeOptionalModel(patch.memoryExtractorModel));
	}
	if (patch.adversaryModel !== undefined) {
		sets.push('adversary_model = ?');
		args.push(normalizeOptionalModel(patch.adversaryModel));
	}
	if (patch.globalMemoryEnabled !== undefined) {
		sets.push('global_memory_enabled = ?');
		args.push(patch.globalMemoryEnabled ? 1 : 0);
	}
	if (patch.approvalMode !== undefined) {
		sets.push('approval_mode = ?');
		args.push(normalizeApprovalMode(patch.approvalMode));
	}
	if (patch.disabledToolGroups !== undefined) {
		sets.push('disabled_tool_groups = ?');
		args.push(JSON.stringify(sanitizeDisabledToolGroups(patch.disabledToolGroups)));
	}
	if (sets.length === 0) return false;
	sets.push('updated_at = ?');
	args.push(Date.now());
	args.push(convInt(id), userId);
	const r = getDb()
		.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
		.run(...args);
	return r.changes > 0;
}

function normalizeOptionalModel(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

/**
 * Record that the user has seen this conversation up to `at` (defaults to now).
 *
 * Monotonic on purpose: concurrent writers (the page `load` and the client's
 * post-turn POST) can settle out of order, and taking the max means a late
 * request carrying an older timestamp can never resurrect an already-read
 * conversation as unseen. Deliberately does NOT touch `updated_at` — reading a
 * conversation must not reorder the sidebar.
 */
export function markRead(id: string | number, userId: number, at: number = Date.now()): boolean {
	const r = getDb()
		.prepare(
			`UPDATE conversations
			    SET last_read_at = MAX(COALESCE(last_read_at, 0), ?)
			  WHERE id = ? AND user_id = ?`
		)
		.run(at, convInt(id), userId);
	return r.changes > 0;
}

/**
 * Ids of the user's non-archived conversations that have assistant output newer
 * than the last time the user looked at them — the "unseen response" half of the
 * sidebar's active indicator. See {@link HAS_UNSEEN_ASSISTANT}.
 */
export function unreadConversationIds(userId: number): Set<string> {
	const rows = getDb()
		.prepare(
			`SELECT c.id AS id
			   FROM conversations c
			  WHERE c.user_id = ?
			    AND c.archived_at IS NULL
			    AND ${HAS_UNSEEN_ASSISTANT}`
		)
		.all(userId) as Array<{ id: number }>;
	return new Set(rows.map((r) => conversationId.encode(r.id)));
}

/** Single-conversation form of {@link unreadConversationIds}. */
export function hasUnread(id: string | number, userId: number): boolean {
	const row = getDb()
		.prepare(
			`SELECT 1 AS hit
			   FROM conversations c
			  WHERE c.id = ?
			    AND c.user_id = ?
			    AND c.archived_at IS NULL
			    AND ${HAS_UNSEEN_ASSISTANT}`
		)
		.get(convInt(id), userId);
	return row !== undefined;
}

export function touch(id: string | number) {
	getDb()
		.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
		.run(Date.now(), convInt(id));
}

/**
 * Record the durable pi session file created for a conversation (the first time
 * its session is opened with persistence). Idempotent: the turn-runner only
 * calls this when the session's file path differs from the stored one, and
 * re-writing the same path is a harmless no-op.
 */
export function setSessionFile(id: string | number, userId: number, sessionFile: string): void {
	getDb()
		.prepare('UPDATE conversations SET session_file = ? WHERE id = ? AND user_id = ?')
		.run(sessionFile, convInt(id), userId);
}

/**
 * Clear a pending composer draft (see `draft_prompt`). Called once the
 * conversation's first turn is started so the draft isn't re-seeded into the
 * composer on subsequent loads.
 *
 * IMPORTANT: this must be invoked from every turn-start entry point. Today the
 * only path that starts a deferred fork's turn is `POST /turns`; if another
 * turn-start path is ever added it must call this too, or a stale draft will
 * keep re-seeding the composer after the turn has already begun.
 */
export function clearDraftPrompt(id: string | number) {
	getDb().prepare('UPDATE conversations SET draft_prompt = NULL WHERE id = ?').run(convInt(id));
}

export function archive(id: string | number, userId: number): boolean {
	const r = getDb()
		.prepare(
			'UPDATE conversations SET archived_at = ? WHERE id = ? AND user_id = ? AND archived_at IS NULL'
		)
		.run(Date.now(), convInt(id), userId);
	return r.changes > 0;
}

export function unarchive(id: string | number, userId: number): boolean {
	const r = getDb()
		.prepare(
			'UPDATE conversations SET archived_at = NULL WHERE id = ? AND user_id = ? AND archived_at IS NOT NULL'
		)
		.run(convInt(id), userId);
	return r.changes > 0;
}

export function remove(id: string | number, userId: number): boolean {
	const intId = convInt(id);
	const db = getDb();
	return db.transaction(() => {
		const r = db
			.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?')
			.run(intId, userId);
		if (r.changes > 0) {
			// FK `ON DELETE CASCADE` cleans the relational memory_* tables, but the
			// memory_search_index FTS5 virtual table can't be a cascade target, so
			// its rows must be purged explicitly or they leak forever. Gating on a
			// real delete avoids touching another user's index on an unauthorized id.
			purgeSessionSearchIndex(db, intId);
		}
		return r.changes > 0;
	})();
}
