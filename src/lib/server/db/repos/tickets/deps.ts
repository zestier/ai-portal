import { getDb } from '../../index';
import { notifyTicketMutation } from '../../ticket-mutations';
import { ticketId as ticketCodec } from '$lib/ids';
import type { TicketDependencyRef } from '$lib/types';
import { get, normalizeStatus, ticketInt } from './core';

// --- Dependency edges -------------------------------------------------------
//
// A row (ticket_id, depends_on) means ticket_id is BLOCKED BY depends_on. All
// mutations are scoped to one user + workspace and guard against cycles; reads
// are plain lookups.

/** depends_on ids for a ticket (its prerequisites), newest edge first. */
export function listDependencies(ticketId: string | number): string[] {
	const intId = ticketInt(ticketId);
	return (
		getDb()
			.prepare(
				`SELECT depends_on FROM ticket_deps WHERE ticket_id = ? ORDER BY created_at DESC, depends_on`
			)
			.all(intId) as { depends_on: number }[]
	).map((r) => ticketCodec.encode(r.depends_on));
}

/** ids of tickets that depend on this ticket (its dependents). */
export function listDependents(ticketId: string | number): string[] {
	const intId = ticketInt(ticketId);
	return (
		getDb()
			.prepare(
				`SELECT ticket_id FROM ticket_deps WHERE depends_on = ? ORDER BY created_at DESC, ticket_id`
			)
			.all(intId) as { ticket_id: number }[]
	).map((r) => ticketCodec.encode(r.ticket_id));
}

/**
 * The subset of a ticket's prerequisites that are still open — i.e. the edges
 * that actively block it. A ticket with an empty list is "ready". Done/archived
 * prerequisites are satisfied and excluded.
 */
export function openBlockers(ticketId: string | number): string[] {
	const intId = ticketInt(ticketId);
	return (
		getDb()
			.prepare(
				`SELECT d.depends_on FROM ticket_deps d
				 JOIN workspace_tickets t ON t.id = d.depends_on
				 WHERE d.ticket_id = ? AND t.status = 'open'
				 ORDER BY d.created_at DESC, d.depends_on`
			)
			.all(intId) as { depends_on: number }[]
	).map((r) => ticketCodec.encode(r.depends_on));
}

// Would adding `ticketId depends_on dependsOn` create a cycle? It does iff
// `dependsOn` already (transitively) depends on `ticketId`. A single recursive
// CTE walks the existing dependency graph from `fromId` and checks whether
// `toId` is reachable, instead of issuing one SELECT per visited node. The CTE
// is UNION (not UNION ALL), so already-visited nodes are deduplicated and any
// pre-existing cycle in the data terminates the walk.
export function dependencyPathExists(fromId: number, toId: number): boolean {
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
export function addDependency(
	userId: number,
	ticketId: string | number,
	dependsOn: string | number
): AddDepResult {
	const result = addDependencyUnnotified(userId, ticketInt(ticketId), ticketInt(dependsOn));
	// Only an actually-added edge changes the sidebar (badges / ordering); an
	// 'exists' no-op leaves the graph untouched, so don't fan out a signal.
	if (result === 'added') notifyTicketMutation({ userId, ticketId: ticketInt(ticketId) });
	return result;
}

/**
 * Edge insert without the mutation notification. Used by `create` and
 * `reconcileEdges`, which emit a single coalesced signal for the whole logical
 * mutation once their transaction commits.
 */
export function addDependencyUnnotified(
	userId: number,
	ticketId: number,
	dependsOn: number
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
export function removeDependency(
	userId: number,
	ticketId: string | number,
	dependsOn: string | number
): boolean {
	const removed = removeDependencyUnnotified(userId, ticketInt(ticketId), ticketInt(dependsOn));
	if (removed) notifyTicketMutation({ userId, ticketId: ticketInt(ticketId) });
	return removed;
}

/** Edge delete without the mutation notification (see `addDependencyUnnotified`). */
export function removeDependencyUnnotified(
	userId: number,
	ticketId: number,
	dependsOn: number
): boolean {
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
export function dependencyRefs(ticketId: string | number, userId: number): TicketDependencyRef[] {
	const intId = ticketInt(ticketId);
	return getDb()
		.prepare(
			`SELECT t.id, t.title, t.status FROM ticket_deps d
			 JOIN workspace_tickets t ON t.id = d.depends_on
			 WHERE d.ticket_id = ? AND t.user_id = ?
			 ORDER BY d.created_at DESC, t.title`
		)
		.all(intId, userId)
		.map((r) => {
			const row = r as { id: number; title: string; status: string };
			return {
				id: ticketCodec.encode(row.id),
				title: row.title,
				status: normalizeStatus(row.status)
			};
		});
}

/** Dependents of a ticket (tickets it blocks), as display refs, any status. Scoped by `userId` (see `dependencyRefs`). */
export function dependentRefs(ticketId: string | number, userId: number): TicketDependencyRef[] {
	const intId = ticketInt(ticketId);
	return getDb()
		.prepare(
			`SELECT t.id, t.title, t.status FROM ticket_deps d
			 JOIN workspace_tickets t ON t.id = d.ticket_id
			 WHERE d.depends_on = ? AND t.user_id = ?
			 ORDER BY d.created_at DESC, t.title`
		)
		.all(intId, userId)
		.map((r) => {
			const row = r as { id: number; title: string; status: string };
			return {
				id: ticketCodec.encode(row.id),
				title: row.title,
				status: normalizeStatus(row.status)
			};
		});
}

// Reconcile one side of a ticket's blocking edges to a desired-state set: add
// edges that are newly desired, remove those no longer present. `side` selects
// the direction — `blockedBy` edges have this ticket as the blocked endpoint,
// `blocks` edges have it as the blocker. addDependency enforces existence /
// same-workspace / no-cycle on each added edge.
export function reconcileEdges(
	userId: number,
	id: number,
	desiredRaw: number[],
	side: 'blockedBy' | 'blocks'
): void {
	const desired = new Set(desiredRaw);
	const current = (side === 'blockedBy' ? listDependencies(id) : listDependents(id)).map((h) =>
		ticketCodec.parse(h)
	);
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
