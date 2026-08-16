import { getDb } from '../../index';
import { notifyTicketMutation } from '../../ticket-mutations';
import { conversationId, messageId, ticketId as ticketCodec } from '$lib/ids';
import type { WorkspaceTicket, WorkspaceTicketPriority, WorkspaceTicketStatus } from '$lib/types';
import { DEFAULT_TICKET_PRIORITY } from '$lib/types';
import { addDependencyUnnotified, reconcileEdges } from './deps';

export interface TicketRow {
	id: number;
	user_id: number;
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
	source_conversation_id: number | null;
	source_message_id: number | null;
	created_at: number;
	updated_at: number;
	closed_at: number | null;
}

export function normalizeStatus(raw: string): WorkspaceTicketStatus {
	return raw === 'done' || raw === 'archived' ? raw : 'open';
}

function normalizePriority(raw: string | undefined): WorkspaceTicketPriority {
	return raw === 'P0' || raw === 'P1' || raw === 'P2' || raw === 'P3'
		? raw
		: DEFAULT_TICKET_PRIORITY;
}

export function rowToTicket(r: TicketRow): WorkspaceTicket {
	return {
		id: ticketCodec.encode(r.id),
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
		sourceConversationId:
			r.source_conversation_id === null ? null : conversationId.encode(r.source_conversation_id),
		sourceMessageId: r.source_message_id === null ? null : messageId.encode(r.source_message_id),
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
	userId: number,
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
	userId: number,
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
	userId: number,
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

export function ticketInt(id: string | number): number {
	return typeof id === 'number' ? id : ticketCodec.parse(id);
}

export function get(id: string | number, userId: number): WorkspaceTicket | null {
	const row = getDb()
		.prepare('SELECT * FROM workspace_tickets WHERE id = ? AND user_id = ?')
		.get(ticketInt(id), userId) as TicketRow | undefined;
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
	blockedBy?: number[];
	/** Ticket ids this new ticket blocks — blocking edges added on insert. */
	blocks?: number[];
	sourceConversationId?: number | null;
	sourceMessageId?: number | null;
}

export function create(userId: number, input: CreateInput): WorkspaceTicket {
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
	let id = 0;
	getDb().transaction(() => {
		const info = getDb()
			.prepare(
				`INSERT INTO workspace_tickets(
				   user_id, workspace_key, title, body, plan, priority, status,
				   source_conversation_id, source_message_id, created_at, updated_at, closed_at
				 ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, NULL)`
			)
			.run(
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
		id = Number(info.lastInsertRowid);
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
		id: ticketCodec.encode(id),
		userId,
		workspaceKey: input.workspaceKey,
		title,
		body,
		plan,
		priority,
		status: 'open',
		sourceConversationId:
			input.sourceConversationId === undefined || input.sourceConversationId === null
				? null
				: conversationId.encode(input.sourceConversationId),
		sourceMessageId:
			input.sourceMessageId === undefined || input.sourceMessageId === null
				? null
				: messageId.encode(input.sourceMessageId),
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
	blockedBy?: number[];
	/** Replace the complete set of tickets this one blocks (see `blockedBy`). */
	blocks?: number[];
}

export function update(
	id: string | number,
	userId: number,
	patch: UpdateInput
): WorkspaceTicket | null {
	const intId = ticketInt(id);
	const current = get(intId, userId);
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
				intId,
				userId
			);
		if (patch.blockedBy !== undefined) reconcileEdges(userId, intId, patch.blockedBy, 'blockedBy');
		if (patch.blocks !== undefined) reconcileEdges(userId, intId, patch.blocks, 'blocks');
	})();
	notifyTicketMutation({ userId, workspaceKey: current.workspaceKey, ticketId: intId });
	return get(intId, userId);
}

export function remove(id: string | number, userId: number): boolean {
	const intId = ticketInt(id);
	const existing = get(intId, userId);
	const r = getDb()
		.prepare('DELETE FROM workspace_tickets WHERE id = ? AND user_id = ?')
		.run(intId, userId);
	if (r.changes > 0) {
		notifyTicketMutation({ userId, workspaceKey: existing?.workspaceKey, ticketId: intId });
	}
	return r.changes > 0;
}
