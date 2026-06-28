import { ulid } from '../ids';
import { getDb } from '../index';
import { notifyTicketMutation } from '../ticket-mutations';
import type {
	TicketDependencyRef,
	WorkspaceTicket,
	WorkspaceTicketPriority,
	WorkspaceTicketStatus
} from '$lib/types';
import { DEFAULT_TICKET_PRIORITY } from '$lib/types';

interface TicketRow {
	id: string;
	user_id: string;
	workspace_key: string;
	title: string;
	body: string;
	// May be undefined if read from a DB whose `plan` column is missing (see the
	// defensive coercion in `rowToTicket`).
	plan: string | undefined;
	// May be undefined if read from a DB predating the priority column (see the
	// defensive coercion in `rowToTicket`).
	priority: string | undefined;
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

function normalizePriority(raw: string | undefined): WorkspaceTicketPriority {
	return raw === 'P0' || raw === 'P1' || raw === 'P2' || raw === 'P3'
		? raw
		: DEFAULT_TICKET_PRIORITY;
}

function rowToTicket(r: TicketRow): WorkspaceTicket {
	return {
		id: r.id,
		userId: r.user_id,
		workspaceKey: r.workspace_key,
		title: r.title,
		body: r.body,
		// Defensive: `plan` was added by a later migration. If a DB somehow lacks
		// the column (e.g. a migration-version collision left 048 skipped), the
		// raw row has no `plan`, so coerce to '' rather than letting `undefined`
		// reach `.trim()` callers and throw.
		plan: r.plan ?? '',
		// Defensive: `priority` was added by migration 053. Coerce an absent or
		// unexpected value to the default rather than leaking `undefined`.
		priority: normalizePriority(r.priority),
		status: normalizeStatus(r.status),
		sourceConversationId: r.source_conversation_id,
		sourceMessageId: r.source_message_id,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		closedAt: r.closed_at
	};
}

/** Ordering for {@link list}. `recency` is the historical default. */
export type TicketListSort = 'recency' | 'priority';

export interface ListOptions {
	status?: WorkspaceTicketStatus | 'all';
	limit?: number;
	/** Number of rows to skip for pagination. Defaults to 0. */
	offset?: number;
	/**
	 * Restrict to a single priority. Omit (the default) to include all
	 * priorities. The filter is applied in SQL so the LIMIT/OFFSET window pages
	 * over the matching set, not a pre-loaded subset.
	 */
	priority?: WorkspaceTicketPriority;
	/**
	 * Result ordering. `recency` (default) preserves the historical
	 * updated_at-first order — including the open-before-other grouping on the
	 * `all` tab. `priority` orders highest-first (P0→P3, sorting correctly as
	 * text), tie-broken by recency, mirroring `listForSidebar`.
	 */
	sort?: TicketListSort;
}

export function list(
	userId: string,
	workspaceKey: string,
	opts: ListOptions = {}
): WorkspaceTicket[] {
	const limit = opts.limit ?? 100;
	const offset = opts.offset ?? 0;
	const status = opts.status ?? 'open';
	const priority = opts.priority;
	const sort = opts.sort ?? 'recency';

	// Build the WHERE incrementally so the optional priority filter pages over
	// the matching set in SQL. The default-args path reproduces the original two
	// queries exactly (status-specific: …AND status = ?; all: no status clause).
	const where: string[] = ['user_id = ?', 'workspace_key = ?'];
	const args: (string | number)[] = [userId, workspaceKey];
	if (status !== 'all') {
		where.push('status = ?');
		args.push(status);
	}
	if (priority) {
		where.push('priority = ?');
		args.push(priority);
	}

	// ORDER BY: priority sort is highest-first (text-sortable P0→P3) then recency,
	// matching `listForSidebar`. Recency keeps today's behavior byte-for-byte,
	// including open-first grouping on the `all` tab.
	const recency = 'updated_at DESC, created_at DESC, id DESC';
	const orderBy =
		sort === 'priority'
			? `priority ASC, ${recency}`
			: status === 'all'
				? `status = 'open' DESC, ${recency}`
				: recency;

	const rows = getDb()
		.prepare(
			`SELECT * FROM workspace_tickets
			 WHERE ${where.join(' AND ')}
			 ORDER BY ${orderBy}
			 LIMIT ? OFFSET ?`
		)
		.all(...args, limit, offset) as TicketRow[];
	return rows.map(rowToTicket);
}

/**
 * Open tickets for a workspace, ordered ready-before-blocked, for the sidebar.
 *
 * Unlike `list()` (recency-only, shared with the `/tickets` index page), this
 * pushes blocked-ness into the query so the `LIMIT` window is filled with
 * actionable (ready) tickets first, then blocked tickets only if fewer than
 * `limit` ready exist. Without this, a recency-then-LIMIT query could fill the
 * whole window with blocked tickets and hide ready ones that exist further down.
 *
 * A ticket is "blocked" iff it has at least one prerequisite edge whose
 * prerequisite ticket is still `status = 'open'` — matching the `blockers`
 * definition used by `dependencyRefs` / `orderSidebarTickets`. Within each group
 * tickets are ordered by `priority` (P0→P3, sorting correctly as text), then
 * `updated_at DESC, created_at DESC, id DESC`, mirroring `list()`.
 */
export function listForSidebar(
	userId: string,
	workspaceKey: string,
	limit = 10
): WorkspaceTicket[] {
	const rows = getDb()
		.prepare(
			`SELECT t.* FROM workspace_tickets t
			 WHERE t.user_id = ? AND t.workspace_key = ? AND t.status = 'open'
			 ORDER BY
			   EXISTS (
			     SELECT 1 FROM ticket_deps d
			     JOIN workspace_tickets dep ON dep.id = d.depends_on
			     WHERE d.ticket_id = t.id AND dep.user_id = t.user_id AND dep.status = 'open'
			   ) ASC,
			   t.priority ASC,
			   t.updated_at DESC, t.created_at DESC, t.id DESC
			 LIMIT ?`
		)
		.all(userId, workspaceKey, limit) as TicketRow[];
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
	/** Relative urgency P0 (highest) … P3 (lowest). Defaults to P2 when omitted. */
	priority?: WorkspaceTicketPriority;
	/** Ticket ids this new ticket is blocked by — blocking edges added on insert. */
	blockedBy?: string[];
	/** Ticket ids this new ticket blocks — blocking edges added on insert. */
	blocks?: string[];
	sourceConversationId?: string | null;
	sourceMessageId?: string | null;
}

export function create(userId: string, input: CreateInput): WorkspaceTicket {
	const id = ulid();
	const now = Date.now();
	const title = input.title.trim();
	const body = input.body?.trim() ?? '';
	const plan = input.plan?.trim() ?? '';
	const priority = input.priority ?? DEFAULT_TICKET_PRIORITY;
	if (!title) throw new Error('ticket title cannot be empty');
	// Insert the row and any blocking edges atomically: edges are created after
	// the row exists (so addDependency's existence/same-workspace/cycle checks see
	// the new ticket), and any bad edge — unknown id, cross-workspace, or a cycle —
	// throws and rolls the whole create back, so a ticket is never half-created.
	getDb().transaction(() => {
		getDb()
			.prepare(
				`INSERT INTO workspace_tickets(
				   id, user_id, workspace_key, title, body, plan, priority, status,
				   source_conversation_id, source_message_id, created_at, updated_at, closed_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, NULL)`
			)
			.run(
				id,
				userId,
				input.workspaceKey,
				title,
				body,
				plan,
				priority,
				input.sourceConversationId ?? null,
				input.sourceMessageId ?? null,
				now,
				now
			);
		for (const blockerId of new Set(input.blockedBy ?? []))
			addDependencyUnnotified(userId, id, blockerId);
		for (const blockedId of new Set(input.blocks ?? []))
			addDependencyUnnotified(userId, blockedId, id);
	})();
	// One notification per logical mutation, after the transaction commits — so a
	// subscriber that re-reads sees the committed row, and the internal edge
	// inserts above don't each fan out a redundant signal.
	notifyTicketMutation({ userId, workspaceKey: input.workspaceKey, ticketId: id });
	return {
		id,
		userId,
		workspaceKey: input.workspaceKey,
		title,
		body,
		plan,
		priority,
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
	/** New relative urgency. Omit to leave unchanged. */
	priority?: WorkspaceTicketPriority;
	status?: WorkspaceTicketStatus;
	/**
	 * Replace the complete set of tickets this one is blocked by. Reconciled as a
	 * desired-state set (edges not listed are removed, new ones added). Omit to
	 * leave blocking edges unchanged; pass `[]` to clear them.
	 */
	blockedBy?: string[];
	/** Replace the complete set of tickets this one blocks (see `blockedBy`). */
	blocks?: string[];
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

	// Scalar update + edge reconciliation run atomically so a bad edge rolls the
	// whole update back rather than leaving a partial change.
	getDb().transaction(() => {
		getDb()
			.prepare(
				`UPDATE workspace_tickets
				 SET title = ?, body = ?, plan = ?, priority = ?, status = ?, updated_at = ?, closed_at = ?
				 WHERE id = ? AND user_id = ?`
			)
			.run(
				patch.title?.trim() ?? current.title,
				patch.body?.trim() ?? current.body,
				patch.plan?.trim() ?? current.plan,
				patch.priority ?? current.priority,
				nextStatus,
				now,
				closedAt,
				id,
				userId
			);
		if (patch.blockedBy !== undefined) reconcileEdges(userId, id, patch.blockedBy, 'blockedBy');
		if (patch.blocks !== undefined) reconcileEdges(userId, id, patch.blocks, 'blocks');
	})();
	notifyTicketMutation({ userId, workspaceKey: current.workspaceKey, ticketId: id });
	return get(id, userId);
}

// Reconcile one side of a ticket's blocking edges to a desired-state set: add
// edges that are newly desired, remove those no longer present. `side` selects
// the direction — `blockedBy` edges have this ticket as the blocked endpoint,
// `blocks` edges have it as the blocker. addDependency enforces existence /
// same-workspace / no-cycle on each added edge.
function reconcileEdges(
	userId: string,
	id: string,
	desiredRaw: string[],
	side: 'blockedBy' | 'blocks'
): void {
	const desired = new Set(desiredRaw);
	const current = side === 'blockedBy' ? listDependencies(id) : listDependents(id);
	const currentSet = new Set(current);
	for (const other of current) {
		if (desired.has(other)) continue;
		if (side === 'blockedBy') removeDependencyUnnotified(userId, id, other);
		else removeDependencyUnnotified(userId, other, id);
	}
	for (const other of desired) {
		if (currentSet.has(other)) continue;
		if (side === 'blockedBy') addDependencyUnnotified(userId, id, other);
		else addDependencyUnnotified(userId, other, id);
	}
}

export function remove(id: string, userId: string): boolean {
	const existing = get(id, userId);
	const r = getDb()
		.prepare('DELETE FROM workspace_tickets WHERE id = ? AND user_id = ?')
		.run(id, userId);
	if (r.changes > 0) {
		notifyTicketMutation({ userId, workspaceKey: existing?.workspaceKey, ticketId: id });
	}
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
// `dependsOn` already (transitively) depends on `ticketId`. A single recursive
// CTE walks the existing dependency graph from `fromId` and checks whether
// `toId` is reachable, instead of issuing one SELECT per visited node. The CTE
// is UNION (not UNION ALL), so already-visited nodes are deduplicated and any
// pre-existing cycle in the data terminates the walk.
function dependencyPathExists(fromId: string, toId: string): boolean {
	if (fromId === toId) return true;
	const row = getDb()
		.prepare(
			`WITH RECURSIVE reachable(id) AS (
			   SELECT depends_on FROM ticket_deps WHERE ticket_id = ?
			   UNION
			   SELECT d.depends_on FROM ticket_deps d
			   JOIN reachable r ON d.ticket_id = r.id
			 )
			 SELECT 1 AS hit FROM reachable WHERE id = ? LIMIT 1`
		)
		.get(fromId, toId) as { hit: number } | undefined;
	return row !== undefined;
}

export type AddDepResult = 'added' | 'exists';

/**
 * Add a dependency edge: `ticketId` becomes blocked by `dependsOn`. Both tickets
 * must belong to `userId` and share a workspace. Throws on a missing ticket, a
 * cross-workspace pairing, a self-edge, or a cycle. Returns 'exists' (no-op) if
 * the edge is already present.
 */
export function addDependency(userId: string, ticketId: string, dependsOn: string): AddDepResult {
	const result = addDependencyUnnotified(userId, ticketId, dependsOn);
	// Only an actually-added edge changes the sidebar (badges / ordering); an
	// 'exists' no-op leaves the graph untouched, so don't fan out a signal.
	if (result === 'added') notifyTicketMutation({ userId, ticketId });
	return result;
}

/**
 * Edge insert without the mutation notification. Used by `create` and
 * `reconcileEdges`, which emit a single coalesced signal for the whole logical
 * mutation once their transaction commits.
 */
function addDependencyUnnotified(
	userId: string,
	ticketId: string,
	dependsOn: string
): AddDepResult {
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
	const removed = removeDependencyUnnotified(userId, ticketId, dependsOn);
	if (removed) notifyTicketMutation({ userId, ticketId });
	return removed;
}

/** Edge delete without the mutation notification (see `addDependencyUnnotified`). */
function removeDependencyUnnotified(userId: string, ticketId: string, dependsOn: string): boolean {
	// Scope the delete to edges whose dependent ticket belongs to the user.
	const owns = get(ticketId, userId);
	if (!owns) return false;
	const r = getDb()
		.prepare('DELETE FROM ticket_deps WHERE ticket_id = ? AND depends_on = ?')
		.run(ticketId, dependsOn);
	return r.changes > 0;
}

/**
 * Prerequisites of a ticket (the tickets it depends on / is blocked by), as
 * display refs (id/title/status), regardless of their status. The status marker
 * lets a detail view distinguish prerequisites that are still open (actively
 * blocking) from ones already satisfied. Use `openBlockers` instead when only
 * the actionable, still-blocking subset is needed.
 *
 * Scoped by `userId` for defense-in-depth: every edge is created same-user by
 * `addDependency`, so this is belt-and-suspenders, but it means a read can never
 * surface another user's title even if an edge were ever created off that path.
 */
export function dependencyRefs(ticketId: string, userId: string): TicketDependencyRef[] {
	return getDb()
		.prepare(
			`SELECT t.id, t.title, t.status FROM ticket_deps d
			 JOIN workspace_tickets t ON t.id = d.depends_on
			 WHERE d.ticket_id = ? AND t.user_id = ?
			 ORDER BY d.created_at DESC, t.title`
		)
		.all(ticketId, userId) as TicketDependencyRef[];
}

/** Dependents of a ticket (tickets it blocks), as display refs, any status. Scoped by `userId` (see `dependencyRefs`). */
export function dependentRefs(ticketId: string, userId: string): TicketDependencyRef[] {
	return getDb()
		.prepare(
			`SELECT t.id, t.title, t.status FROM ticket_deps d
			 JOIN workspace_tickets t ON t.id = d.ticket_id
			 WHERE d.depends_on = ? AND t.user_id = ?
			 ORDER BY d.created_at DESC, t.title`
		)
		.all(ticketId, userId) as TicketDependencyRef[];
}
