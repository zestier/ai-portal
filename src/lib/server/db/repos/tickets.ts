import { ulid } from '../ids';
import { getDb } from '../index';
import type { WorkspaceTicket, WorkspaceTicketStatus } from '$lib/types';

interface TicketRow {
	id: string;
	user_id: string;
	workspace_key: string;
	title: string;
	body: string;
	plan: string;
	status: string;
	source_conversation_id: string | null;
	source_message_id: string | null;
	created_at: number;
	updated_at: number;
	closed_at: number | null;
}

function normalizeStatus(raw: string): WorkspaceTicketStatus {
	return raw === 'done' || raw === 'archived' ? raw : 'open';
}

function rowToTicket(r: TicketRow): WorkspaceTicket {
	return {
		id: r.id,
		userId: r.user_id,
		workspaceKey: r.workspace_key,
		title: r.title,
		body: r.body,
		plan: r.plan,
		status: normalizeStatus(r.status),
		sourceConversationId: r.source_conversation_id,
		sourceMessageId: r.source_message_id,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		closedAt: r.closed_at
	};
}

export interface ListOptions {
	status?: WorkspaceTicketStatus | 'all';
	limit?: number;
}

export function list(
	userId: string,
	workspaceKey: string,
	opts: ListOptions = {}
): WorkspaceTicket[] {
	const limit = opts.limit ?? 100;
	const status = opts.status ?? 'open';
	const rows =
		status === 'all'
			? (getDb()
					.prepare(
						`SELECT * FROM workspace_tickets
						 WHERE user_id = ? AND workspace_key = ?
						 ORDER BY status = 'open' DESC, updated_at DESC, created_at DESC
						 LIMIT ?`
					)
					.all(userId, workspaceKey, limit) as TicketRow[])
			: (getDb()
					.prepare(
						`SELECT * FROM workspace_tickets
						 WHERE user_id = ? AND workspace_key = ? AND status = ?
						 ORDER BY updated_at DESC, created_at DESC
						 LIMIT ?`
					)
					.all(userId, workspaceKey, status, limit) as TicketRow[]);
	return rows.map(rowToTicket);
}

export function count(
	userId: string,
	workspaceKey: string,
	status: WorkspaceTicketStatus = 'open'
): number {
	const row = getDb()
		.prepare(
			`SELECT COUNT(*) AS count FROM workspace_tickets
			 WHERE user_id = ? AND workspace_key = ? AND status = ?`
		)
		.get(userId, workspaceKey, status) as { count: number } | undefined;
	return row?.count ?? 0;
}

export function get(id: string, userId: string): WorkspaceTicket | null {
	const row = getDb()
		.prepare('SELECT * FROM workspace_tickets WHERE id = ? AND user_id = ?')
		.get(id, userId) as TicketRow | undefined;
	return row ? rowToTicket(row) : null;
}

export interface CreateInput {
	workspaceKey: string;
	title: string;
	body?: string;
	plan?: string;
	sourceConversationId?: string | null;
	sourceMessageId?: string | null;
}

export function create(userId: string, input: CreateInput): WorkspaceTicket {
	const id = ulid();
	const now = Date.now();
	const title = input.title.trim();
	const body = input.body?.trim() ?? '';
	const plan = input.plan?.trim() ?? '';
	if (!title) throw new Error('ticket title cannot be empty');
	getDb()
		.prepare(
			`INSERT INTO workspace_tickets(
			   id, user_id, workspace_key, title, body, plan, status,
			   source_conversation_id, source_message_id, created_at, updated_at, closed_at
			 ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, NULL)`
		)
		.run(
			id,
			userId,
			input.workspaceKey,
			title,
			body,
			plan,
			input.sourceConversationId ?? null,
			input.sourceMessageId ?? null,
			now,
			now
		);
	return {
		id,
		userId,
		workspaceKey: input.workspaceKey,
		title,
		body,
		plan,
		status: 'open',
		sourceConversationId: input.sourceConversationId ?? null,
		sourceMessageId: input.sourceMessageId ?? null,
		createdAt: now,
		updatedAt: now,
		closedAt: null
	};
}

export interface UpdateInput {
	title?: string;
	body?: string;
	plan?: string;
	status?: WorkspaceTicketStatus;
}

export function update(id: string, userId: string, patch: UpdateInput): WorkspaceTicket | null {
	const current = get(id, userId);
	if (!current) return null;

	const title = patch.title?.trim();
	if (title !== undefined && !title) throw new Error('ticket title cannot be empty');
	const nextStatus = patch.status ?? current.status;
	const now = Date.now();
	const closedAt =
		nextStatus === 'done' || nextStatus === 'archived' ? (current.closedAt ?? now) : null;

	getDb()
		.prepare(
			`UPDATE workspace_tickets
			 SET title = ?, body = ?, plan = ?, status = ?, updated_at = ?, closed_at = ?
			 WHERE id = ? AND user_id = ?`
		)
		.run(
			patch.title?.trim() ?? current.title,
			patch.body?.trim() ?? current.body,
			patch.plan?.trim() ?? current.plan,
			nextStatus,
			now,
			closedAt,
			id,
			userId
		);
	return get(id, userId);
}

export function remove(id: string, userId: string): boolean {
	const r = getDb()
		.prepare('DELETE FROM workspace_tickets WHERE id = ? AND user_id = ?')
		.run(id, userId);
	return r.changes > 0;
}

// --- Dependency edges -------------------------------------------------------
//
// A row (ticket_id, depends_on) means ticket_id is BLOCKED BY depends_on. All
// mutations are scoped to one user + workspace and guard against cycles; reads
// are plain lookups.

/** depends_on ids for a ticket (its prerequisites), newest edge first. */
export function listDependencies(ticketId: string): string[] {
	return (
		getDb()
			.prepare(
				`SELECT depends_on FROM ticket_deps WHERE ticket_id = ? ORDER BY created_at DESC, depends_on`
			)
			.all(ticketId) as { depends_on: string }[]
	).map((r) => r.depends_on);
}

/** ids of tickets that depend on this ticket (its dependents). */
export function listDependents(ticketId: string): string[] {
	return (
		getDb()
			.prepare(
				`SELECT ticket_id FROM ticket_deps WHERE depends_on = ? ORDER BY created_at DESC, ticket_id`
			)
			.all(ticketId) as { ticket_id: string }[]
	).map((r) => r.ticket_id);
}

/**
 * The subset of a ticket's prerequisites that are still open — i.e. the edges
 * that actively block it. A ticket with an empty list is "ready". Done/archived
 * prerequisites are satisfied and excluded.
 */
export function openBlockers(ticketId: string): string[] {
	return (
		getDb()
			.prepare(
				`SELECT d.depends_on FROM ticket_deps d
				 JOIN workspace_tickets t ON t.id = d.depends_on
				 WHERE d.ticket_id = ? AND t.status = 'open'
				 ORDER BY d.created_at DESC, d.depends_on`
			)
			.all(ticketId) as { depends_on: string }[]
	).map((r) => r.depends_on);
}

// Would adding `ticketId depends_on dependsOn` create a cycle? It does iff
// `dependsOn` already (transitively) depends on `ticketId`. Walk the existing
// dependency graph from `dependsOn` and see if `ticketId` is reachable.
function dependencyPathExists(fromId: string, toId: string): boolean {
	const seen = new Set<string>();
	const stack = [fromId];
	while (stack.length) {
		const node = stack.pop()!;
		if (node === toId) return true;
		if (seen.has(node)) continue;
		seen.add(node);
		for (const next of listDependencies(node)) stack.push(next);
	}
	return false;
}

export type AddDepResult = 'added' | 'exists';

/**
 * Add a dependency edge: `ticketId` becomes blocked by `dependsOn`. Both tickets
 * must belong to `userId` and share a workspace. Throws on a missing ticket, a
 * cross-workspace pairing, a self-edge, or a cycle. Returns 'exists' (no-op) if
 * the edge is already present.
 */
export function addDependency(userId: string, ticketId: string, dependsOn: string): AddDepResult {
	if (ticketId === dependsOn) throw new Error('a ticket cannot depend on itself');
	const ticket = get(ticketId, userId);
	if (!ticket) throw new Error(`ticket not found: ${ticketId}`);
	const prereq = get(dependsOn, userId);
	if (!prereq) throw new Error(`ticket not found: ${dependsOn}`);
	if (ticket.workspaceKey !== prereq.workspaceKey) {
		throw new Error('tickets are in different workspaces');
	}
	// `dependsOn` reaching `ticketId` through existing edges means the new edge
	// would close a cycle.
	if (dependencyPathExists(dependsOn, ticketId)) {
		throw new Error(
			`adding this dependency would create a cycle (${dependsOn} -> … -> ${ticketId})`
		);
	}
	const r = getDb()
		.prepare(
			`INSERT OR IGNORE INTO ticket_deps(ticket_id, depends_on, created_at) VALUES (?, ?, ?)`
		)
		.run(ticketId, dependsOn, Date.now());
	return r.changes > 0 ? 'added' : 'exists';
}

/** Remove a dependency edge. Returns false when no such edge existed. */
export function removeDependency(userId: string, ticketId: string, dependsOn: string): boolean {
	// Scope the delete to edges whose dependent ticket belongs to the user.
	const owns = get(ticketId, userId);
	if (!owns) return false;
	const r = getDb()
		.prepare('DELETE FROM ticket_deps WHERE ticket_id = ? AND depends_on = ?')
		.run(ticketId, dependsOn);
	return r.changes > 0;
}
