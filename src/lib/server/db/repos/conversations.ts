import { ulid } from '../ids';
import { getDb } from '../index';
import { loadConfig } from '../../config';
import { purgeSessionSearchIndex } from './memory';
import {
	normalizeApprovalMode,
	normalizeBackendProvider,
	normalizeMemoryExtractorBackend,
	normalizeMemoryMode,
	normalizeSessionMode,
	type ApprovalMode,
	type BackendProviderId,
	type Conversation,
	type MemoryExtractorBackend,
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
	id: string;
	user_id: string;
	title: string;
	workdir: string;
	provider: string | null;
	model: string | null;
	created_at: number;
	updated_at: number;
	archived_at: number | null;
	forked_from_conversation_id: string | null;
	forked_from_message_id: string | null;
	provider_session_id: string | null;
	mode: string | null;
	memory_mode: string | null;
	memory_extractor_model: string | null;
	memory_extractor_backend: string | null;
	adversary_model: string | null;
	global_memory_enabled: number | null;
	approval_mode: string | null;
	disabled_tool_groups: string | null;
	draft_prompt: string | null;
	workspace_kind: WorkspaceKind;
	workspace_key: string | null;
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
		id: r.id,
		userId: r.user_id,
		title: r.title,
		workdir: r.workdir,
		provider: normalizeBackendProvider(r.provider),
		model: r.model,
		mode,
		memoryMode: normalizeMemoryMode(r.memory_mode),
		memoryExtractorModel: r.memory_extractor_model ?? null,
		memoryExtractorBackend: normalizeMemoryExtractorBackend(r.memory_extractor_backend),
		adversaryModel: r.adversary_model ?? null,
		globalMemoryEnabled: r.global_memory_enabled === 1,
		approvalMode: normalizeApprovalMode(r.approval_mode),
		disabledToolGroups: parseDisabledToolGroups(r.disabled_tool_groups),
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		archivedAt: r.archived_at,
		forkedFromConversationId: r.forked_from_conversation_id,
		forkedFromMessageId: r.forked_from_message_id,
		providerSessionId: r.provider_session_id ?? r.id,
		draftPrompt: r.draft_prompt ?? null,
		workspaceKind: r.workspace_kind ?? 'shared',
		workspaceKey: r.workspace_key ?? effectiveWorkdir(r.workdir),
		worktreeBranch: r.worktree_branch ?? null,
		worktreeBaseSha: r.worktree_base_sha ?? null
	};
}

export function get(id: string, userId: string): Conversation | null {
	const r = getDb()
		.prepare(`${CONVERSATION_SELECT} WHERE conversations.id = ? AND conversations.user_id = ?`)
		.get(id, userId) as ConvRow | undefined;
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
export function listChildren(userId: string, sourceId: string): Conversation[] {
	const rows = getDb()
		.prepare(
			`${CONVERSATION_SELECT}
			 WHERE conversations.user_id = ? AND conversations.forked_from_conversation_id = ?
			 ORDER BY created_at ASC`
		)
		.all(userId, sourceId) as ConvRow[];
	return rows.map(rowToConv);
}

export function list(userId: string, opts: ListOpts = {}): Conversation[] {
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
	provider?: BackendProviderId;
	model: string | null;
	mode?: SessionMode;
	approvalMode?: ApprovalMode;
	memoryMode?: MemoryMode;
	memoryExtractorModel?: string | null;
	memoryExtractorBackend?: MemoryExtractorBackend | null;
	adversaryModel?: string | null;
	globalMemoryEnabled?: boolean;
	disabledToolGroups?: string[];
	id?: string;
	forkedFromConversationId?: string | null;
	forkedFromMessageId?: string | null;
	providerSessionId?: string | null;
	draftPrompt?: string | null;
	workspaceKind?: WorkspaceKind;
	workspaceKey?: string;
	managedWorktree?: ManagedWorktreeMetadata;
}

/**
 * Mint a fresh conversation id without touching the database. Useful when
 * the caller needs the id to derive other state (e.g. workdir path) before
 * inserting the row.
 */
export function newId(): string {
	return ulid();
}

export function create(userId: string, input: CreateInput): Conversation {
	const id = input.id ?? ulid();
	const now = Date.now();
	const forkConv = input.forkedFromConversationId ?? null;
	const forkMsg = input.forkedFromMessageId ?? null;
	const providerSessionId = input.providerSessionId ?? id;
	const mode = input.mode ?? 'interactive';
	const approvalMode = normalizeApprovalMode(input.approvalMode);
	const memoryMode = input.memoryMode ?? 'off';
	const memoryExtractorModel = normalizeOptionalModel(input.memoryExtractorModel);
	const memoryExtractorBackend = normalizeMemoryExtractorBackend(input.memoryExtractorBackend);
	const adversaryModel = normalizeOptionalModel(input.adversaryModel);
	const globalMemoryEnabled = input.globalMemoryEnabled === true;
	const disabledToolGroups = sanitizeDisabledToolGroups(input.disabledToolGroups);
	const provider =
		input.provider ?? normalizeBackendProvider(loadConfig().DEFAULT_BACKEND_PROVIDER);
	const draftPrompt = input.draftPrompt ?? null;
	const workspaceKind = input.workspaceKind ?? 'shared';
	const workspaceKey = input.workspaceKey ?? effectiveWorkdir(input.workdir);
	const db = getDb();
	db.transaction(() => {
		db.prepare(
			`INSERT INTO conversations(
			   id, user_id, title, workdir, provider, model, mode, approval_mode, memory_mode, memory_extractor_model,
			   memory_extractor_backend, adversary_model, global_memory_enabled, disabled_tool_groups, created_at, updated_at,
			   forked_from_conversation_id, forked_from_message_id, provider_session_id, draft_prompt,
			   workspace_kind, workspace_key
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			id,
			userId,
			input.title,
			input.workdir,
			provider,
			input.model,
			mode,
			approvalMode,
			memoryMode,
			memoryExtractorModel,
			memoryExtractorBackend,
			adversaryModel,
			globalMemoryEnabled ? 1 : 0,
			JSON.stringify(disabledToolGroups),
			now,
			now,
			forkConv,
			forkMsg,
			providerSessionId,
			draftPrompt,
			workspaceKind,
			workspaceKey
		);
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
		id,
		userId,
		title: input.title,
		workdir: input.workdir,
		provider,
		model: input.model,
		mode,
		memoryMode,
		memoryExtractorModel,
		memoryExtractorBackend,
		adversaryModel,
		globalMemoryEnabled,
		approvalMode,
		disabledToolGroups,
		createdAt: now,
		updatedAt: now,
		archivedAt: null,
		forkedFromConversationId: forkConv,
		forkedFromMessageId: forkMsg,
		providerSessionId,
		draftPrompt,
		workspaceKind,
		workspaceKey,
		worktreeBranch: input.managedWorktree?.branch ?? null,
		worktreeBaseSha: input.managedWorktree?.baseSha ?? null
	};
}

export function getManagedWorktree(id: string, userId: string): ManagedWorktreeMetadata | null {
	const row = getDb()
		.prepare(
			`SELECT mw.source_workdir, mw.path, mw.git_common_dir, mw.branch, mw.base_sha
			   FROM managed_worktrees mw
			   JOIN conversations c ON c.id = mw.conversation_id
			  WHERE mw.conversation_id = ? AND c.user_id = ?`
		)
		.get(id, userId) as
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

export function rotateProviderSession(id: string, userId: string): string | null {
	const providerSessionId = ulid();
	const r = getDb()
		.prepare(
			`UPDATE conversations
			    SET provider_session_id = ?, updated_at = ?
			  WHERE id = ? AND user_id = ?`
		)
		.run(providerSessionId, Date.now(), id, userId);
	return r.changes > 0 ? providerSessionId : null;
}

export function setProviderSessionId(
	id: string,
	userId: string,
	providerSessionId: string
): boolean {
	const r = getDb()
		.prepare(
			`UPDATE conversations
			    SET provider_session_id = ?, updated_at = ?
			  WHERE id = ? AND user_id = ?`
		)
		.run(providerSessionId, Date.now(), id, userId);
	return r.changes > 0;
}

export function rename(id: string, userId: string, title: string): boolean {
	const r = getDb()
		.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?')
		.run(title, Date.now(), id, userId);
	return r.changes > 0;
}

export function renameIfDefault(id: string, userId: string, title: string): boolean {
	const r = getDb()
		.prepare(
			`UPDATE conversations
			    SET title = ?, updated_at = ?
			  WHERE id = ? AND user_id = ? AND (title = '' OR trim(title) = 'New chat')`
		)
		.run(title, Date.now(), id, userId);
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
	id: string,
	userId: string,
	patch: {
		model?: string;
		mode?: SessionMode;
		memoryMode?: MemoryMode;
		memoryExtractorModel?: string | null;
		memoryExtractorBackend?: MemoryExtractorBackend | null;
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
	if (patch.memoryExtractorBackend !== undefined) {
		sets.push('memory_extractor_backend = ?');
		args.push(normalizeMemoryExtractorBackend(patch.memoryExtractorBackend));
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
	args.push(id, userId);
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
export function markRead(id: string, userId: string, at: number = Date.now()): boolean {
	const r = getDb()
		.prepare(
			`UPDATE conversations
			    SET last_read_at = MAX(COALESCE(last_read_at, 0), ?)
			  WHERE id = ? AND user_id = ?`
		)
		.run(at, id, userId);
	return r.changes > 0;
}

/**
 * Ids of the user's non-archived conversations that have assistant output newer
 * than the last time the user looked at them — the "unseen response" half of the
 * sidebar's active indicator. See {@link HAS_UNSEEN_ASSISTANT}.
 */
export function unreadConversationIds(userId: string): Set<string> {
	const rows = getDb()
		.prepare(
			`SELECT c.id AS id
			   FROM conversations c
			  WHERE c.user_id = ?
			    AND c.archived_at IS NULL
			    AND ${HAS_UNSEEN_ASSISTANT}`
		)
		.all(userId) as Array<{ id: string }>;
	return new Set(rows.map((r) => r.id));
}

/** Single-conversation form of {@link unreadConversationIds}. */
export function hasUnread(id: string, userId: string): boolean {
	const row = getDb()
		.prepare(
			`SELECT 1 AS hit
			   FROM conversations c
			  WHERE c.id = ?
			    AND c.user_id = ?
			    AND c.archived_at IS NULL
			    AND ${HAS_UNSEEN_ASSISTANT}`
		)
		.get(id, userId);
	return row !== undefined;
}

export function touch(id: string) {
	getDb().prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), id);
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
export function clearDraftPrompt(id: string) {
	getDb().prepare('UPDATE conversations SET draft_prompt = NULL WHERE id = ?').run(id);
}

export function archive(id: string, userId: string): boolean {
	const r = getDb()
		.prepare(
			'UPDATE conversations SET archived_at = ? WHERE id = ? AND user_id = ? AND archived_at IS NULL'
		)
		.run(Date.now(), id, userId);
	return r.changes > 0;
}

export function unarchive(id: string, userId: string): boolean {
	const r = getDb()
		.prepare(
			'UPDATE conversations SET archived_at = NULL WHERE id = ? AND user_id = ? AND archived_at IS NOT NULL'
		)
		.run(id, userId);
	return r.changes > 0;
}

export function remove(id: string, userId: string): boolean {
	const db = getDb();
	return db.transaction(() => {
		const r = db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').run(id, userId);
		if (r.changes > 0) {
			// FK `ON DELETE CASCADE` cleans the relational memory_* tables, but the
			// memory_search_index FTS5 virtual table can't be a cascade target, so
			// its rows must be purged explicitly or they leak forever. Gating on a
			// real delete avoids touching another user's index on an unauthorized id.
			purgeSessionSearchIndex(db, id);
		}
		return r.changes > 0;
	})();
}
