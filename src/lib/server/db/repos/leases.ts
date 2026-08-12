// Persistence for workspace leases — portal-owned checkouts an agent creates
// for parallel sub-agent work. See `docs/architecture.md` — "Worktree leases
// (parallel sub-agent work)".
//
// This repo is deliberately dumb: it stores and returns rows. Every path it
// hands back is UNTRUSTED until `leases.ts` re-derives it from ids and verifies
// it against the filesystem, mirroring how `managed_worktrees` rows are treated.

import { getDb } from '../index';

export interface LeaseRow {
	id: string;
	userId: string;
	heldByConversationId: string | null;
	label: string;
	sourceWorkdir: string;
	gitCommonDir: string;
	path: string;
	branch: string;
	baseSha: string;
	state: 'active' | 'releasing';
	createdAt: number;
	lastUsedAt: number;
}

interface RawLeaseRow {
	id: string;
	user_id: string;
	held_by_conversation_id: string | null;
	label: string;
	source_workdir: string;
	git_common_dir: string;
	path: string;
	branch: string;
	base_sha: string;
	state: string;
	created_at: number;
	last_used_at: number;
}

function toLease(r: RawLeaseRow): LeaseRow {
	return {
		id: r.id,
		userId: r.user_id,
		heldByConversationId: r.held_by_conversation_id,
		label: r.label,
		sourceWorkdir: r.source_workdir,
		gitCommonDir: r.git_common_dir,
		path: r.path,
		branch: r.branch,
		baseSha: r.base_sha,
		state: r.state === 'releasing' ? 'releasing' : 'active',
		createdAt: r.created_at,
		lastUsedAt: r.last_used_at
	};
}

export interface InsertLeaseInput {
	id: string;
	userId: string;
	heldByConversationId: string;
	label: string;
	sourceWorkdir: string;
	gitCommonDir: string;
	path: string;
	branch: string;
	baseSha: string;
}

export function insert(input: InsertLeaseInput): LeaseRow {
	const now = Date.now();
	getDb()
		.prepare(
			`INSERT INTO workspace_leases(
			   id, user_id, held_by_conversation_id, label, source_workdir,
			   git_common_dir, path, branch, base_sha, state, created_at, last_used_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
		)
		.run(
			input.id,
			input.userId,
			input.heldByConversationId,
			input.label,
			input.sourceWorkdir,
			input.gitCommonDir,
			input.path,
			input.branch,
			input.baseSha,
			now,
			now
		);
	const row = getById(input.id, input.userId);
	if (!row) throw new Error('lease insert did not persist');
	return row;
}

export function getById(id: string, userId: string): LeaseRow | null {
	const row = getDb()
		.prepare(`SELECT * FROM workspace_leases WHERE id = ? AND user_id = ?`)
		.get(id, userId) as RawLeaseRow | undefined;
	return row ? toLease(row) : null;
}

export function listByConversation(conversationId: string, userId: string): LeaseRow[] {
	const rows = getDb()
		.prepare(
			`SELECT * FROM workspace_leases
			  WHERE held_by_conversation_id = ? AND user_id = ?
			  ORDER BY created_at ASC`
		)
		.all(conversationId, userId) as RawLeaseRow[];
	return rows.map(toLease);
}

export function countByConversation(conversationId: string): number {
	const row = getDb()
		.prepare(
			`SELECT COUNT(*) AS n FROM workspace_leases WHERE held_by_conversation_id = ? AND state = 'active'`
		)
		.get(conversationId) as { n: number };
	return row.n;
}

export function countByUser(userId: string): number {
	const row = getDb()
		.prepare(`SELECT COUNT(*) AS n FROM workspace_leases WHERE user_id = ? AND state = 'active'`)
		.get(userId) as { n: number };
	return row.n;
}

/** All leases, for startup reconciliation. Not user-scoped by design. */
export function listAll(): LeaseRow[] {
	const rows = getDb()
		.prepare(`SELECT * FROM workspace_leases ORDER BY created_at ASC`)
		.all() as RawLeaseRow[];
	return rows.map(toLease);
}

/**
 * Leases eligible for idle reaping: active and untouched since `before`.
 * Dirtiness is checked by the caller against the real checkout, since it can't
 * be known from the row.
 */
export function listIdle(before: number): LeaseRow[] {
	const rows = getDb()
		.prepare(
			`SELECT * FROM workspace_leases
			  WHERE state = 'active' AND last_used_at < ?
			  ORDER BY last_used_at ASC`
		)
		.all(before) as RawLeaseRow[];
	return rows.map(toLease);
}

export function touch(id: string, now = Date.now()): void {
	getDb().prepare(`UPDATE workspace_leases SET last_used_at = ? WHERE id = ?`).run(now, id);
}

export function setState(id: string, state: 'active' | 'releasing'): void {
	getDb().prepare(`UPDATE workspace_leases SET state = ? WHERE id = ?`).run(state, id);
}

export function remove(id: string): void {
	getDb().prepare(`DELETE FROM workspace_leases WHERE id = ?`).run(id);
}
