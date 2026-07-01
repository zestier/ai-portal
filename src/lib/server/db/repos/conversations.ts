import { ulid } from '../ids';
import { getDb } from '../index';
import { loadConfig } from '../../config';
import { purgeSessionSearchIndex } from './memory';
import {
	normalizeBackendProvider,
	normalizeMemoryExtractorBackend,
	normalizeMemoryMode,
	normalizeSessionMode,
	type BackendProviderId,
	type Conversation,
	type MemoryExtractorBackend,
	type MemoryMode,
	type SessionMode
} from '$lib/types';
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
	global_memory_enabled: number | null;
	approve_all_tools: number | null;
	disabled_tool_groups: string | null;
	draft_prompt: string | null;
}

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
		globalMemoryEnabled: r.global_memory_enabled === 1,
		approveAllTools: r.approve_all_tools === 1,
		disabledToolGroups: parseDisabledToolGroups(r.disabled_tool_groups),
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		archivedAt: r.archived_at,
		forkedFromConversationId: r.forked_from_conversation_id,
		forkedFromMessageId: r.forked_from_message_id,
		providerSessionId: r.provider_session_id ?? r.id,
		draftPrompt: r.draft_prompt ?? null
	};
}

export function get(id: string, userId: string): Conversation | null {
	const r = getDb()
		.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
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
			`SELECT * FROM conversations
			 WHERE user_id = ? AND forked_from_conversation_id = ?
			 ORDER BY created_at ASC`
		)
		.all(userId, sourceId) as ConvRow[];
	return rows.map(rowToConv);
}

export function list(userId: string, opts: ListOpts = {}): Conversation[] {
	const limit = opts.limit ?? 200;
	const sql = opts.includeArchived
		? `SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?`
		: `SELECT * FROM conversations WHERE user_id = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT ?`;
	const rows = getDb().prepare(sql).all(userId, limit) as ConvRow[];
	return rows.map(rowToConv);
}

export interface CreateInput {
	title: string;
	workdir: string;
	provider?: BackendProviderId;
	model: string | null;
	mode?: SessionMode;
	memoryMode?: MemoryMode;
	memoryExtractorModel?: string | null;
	memoryExtractorBackend?: MemoryExtractorBackend | null;
	globalMemoryEnabled?: boolean;
	disabledToolGroups?: string[];
	id?: string;
	forkedFromConversationId?: string | null;
	forkedFromMessageId?: string | null;
	providerSessionId?: string | null;
	draftPrompt?: string | null;
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
	const memoryMode = input.memoryMode ?? 'off';
	const memoryExtractorModel = normalizeOptionalModel(input.memoryExtractorModel);
	const memoryExtractorBackend = normalizeMemoryExtractorBackend(input.memoryExtractorBackend);
	const globalMemoryEnabled = input.globalMemoryEnabled === true;
	const disabledToolGroups = sanitizeDisabledToolGroups(input.disabledToolGroups);
	const provider =
		input.provider ?? normalizeBackendProvider(loadConfig().DEFAULT_BACKEND_PROVIDER);
	const draftPrompt = input.draftPrompt ?? null;
	getDb()
		.prepare(
			`INSERT INTO conversations(
			   id, user_id, title, workdir, provider, model, mode, memory_mode, memory_extractor_model,
			   memory_extractor_backend, global_memory_enabled, disabled_tool_groups, created_at, updated_at,
			   forked_from_conversation_id, forked_from_message_id, provider_session_id, draft_prompt
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			id,
			userId,
			input.title,
			input.workdir,
			provider,
			input.model,
			mode,
			memoryMode,
			memoryExtractorModel,
			memoryExtractorBackend,
			globalMemoryEnabled ? 1 : 0,
			JSON.stringify(disabledToolGroups),
			now,
			now,
			forkConv,
			forkMsg,
			providerSessionId,
			draftPrompt
		);
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
		globalMemoryEnabled,
		approveAllTools: false,
		disabledToolGroups,
		createdAt: now,
		updatedAt: now,
		archivedAt: null,
		forkedFromConversationId: forkConv,
		forkedFromMessageId: forkMsg,
		providerSessionId,
		draftPrompt
	};
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
 * Update per-conversation session settings (model, mode, and/or approve-all bypass).
 * Returns true iff a row was modified. The bridge reads these on each
 * `pool.acquire` so a recreated session inherits the latest values; the
 * /session PATCH endpoint additionally pushes them to the live SDK session
 * via `session.setMode` / `session.setApproveAll` when supported.
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
		globalMemoryEnabled?: boolean;
		approveAllTools?: boolean;
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
	if (patch.globalMemoryEnabled !== undefined) {
		sets.push('global_memory_enabled = ?');
		args.push(patch.globalMemoryEnabled ? 1 : 0);
	}
	if (patch.approveAllTools !== undefined) {
		sets.push('approve_all_tools = ?');
		args.push(patch.approveAllTools ? 1 : 0);
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
