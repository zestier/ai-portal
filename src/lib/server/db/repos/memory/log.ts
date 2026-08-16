import type Database from 'better-sqlite3';
import { getDb } from '../../index';
import { conversationId, messageId } from '$lib/ids';
import {
	appendSessionMemoryLog,
	chainRowsForHead,
	clearSessionMemoryProjection,
	dropMemoryMessageHead,
	gcMemoryEventChain,
	getCurrentMemoryHead,
	headForMessagePrefix,
	payloadObject,
	rebuildSessionMemoryProjectionInTransaction
} from './common';
import {
	codecFor,
	convInt,
	normalizeKind,
	patchItemTargetId,
	parseJson,
	toIntId,
	type MemoryEntity,
	type MemoryEvent,
	type MemoryFact,
	type MemoryOpenLoop,
	type MemoryPatch,
	type MemoryPatchItem,
	type MemoryToolCall,
	type MemoryValidationIssue,
	type SessionMemoryLogItemType,
	type SessionProjectionTable
} from './rows';
import { updateEntity } from './entities';
import { updateFact } from './facts';
import { updateOpenLoop } from './loops';
import { listPatchItems } from './patches';

export function deleteItem(
	conversationId: string | number,
	kind: string,
	id: string | number
): boolean {
	const intConv = convInt(conversationId);
	const normalized = normalizeKind(kind);
	if (!normalized) return false;
	if (normalized === 'entity') return updateEntity(intConv, id, { status: 'deleted' }) !== null;
	if (normalized === 'fact') return updateFact(intConv, id, { status: 'deleted' }) !== null;
	if (normalized === 'open_loop')
		return (
			updateOpenLoop(intConv, typeof id === 'number' ? id : Number(id) || 0, {
				status: 'deleted'
			}) !== null
		);
	return false;
}

/**
 * Undo a committed patch for the retry path: delete what it created, reopen the
 * loops it resolved, restore the facts it forgot, then rebuild the projection so
 * consolidation (supersede/dedupe) is re-derived from the surviving event
 * stream rather than hand-maintained. Re-deriving the active set this way leaves
 * the patch ROW itself intact (history is preserved — there is no 'reverted'
 * status). Invoked by the deferred commit-time hook in `startExtractionRetryTurn`
 * once a replacement patch validates, so a failed/aborted/needs_review retry
 * never reaches it. Mutates durable state.
 */
export function revertCommittedPatch(conversationId: string | number, patchId: number): void {
	const intConv = convInt(conversationId);
	const items = listPatchItems(intConv, { patchId, limit: 1000 });
	const db = getDb();
	// Apply every item AND rebuild the projection inside one transaction so a
	// crash mid-loop can't leave a half-reverted state (some facts restored,
	// others deleted, projection stale). The helpers below open their own
	// db.transaction(...); better-sqlite3 nests these as savepoints, so the
	// whole revert commits or rolls back atomically.
	const tx = db.transaction(() => {
		for (const item of items) {
			if (item.action === 'create') {
				deleteItem(intConv, item.itemType, item.itemId);
			} else if (item.action === 'resolve' && item.itemType === 'open_loop') {
				updateOpenLoop(
					intConv,
					typeof item.itemId === 'number' ? item.itemId : Number(item.itemId) || 0,
					{ status: 'open' }
				);
			} else if (item.action === 'forget' && item.itemType === 'fact') {
				updateFact(intConv, item.itemId, { status: 'active' });
			}
		}
		rebuildSessionMemoryProjection(intConv);
	});
	tx();
}

/**
 * The memory chain head as of just before `messageId` — i.e. the projection
 * "commit" the turn that owns `messageId` branched from. Memory for a turn is
 * appended pinned to its assistant message, so the most recent head among
 * strictly-earlier messages is the state the turn started from. Null when no
 * earlier message carries memory (the turn is the first memory-bearing one).
 */
function headBeforeMessage(
	db: Database.Database,
	conversationId: number,
	messageId: number
): string | null {
	const row = db
		.prepare(
			`SELECT h.head_event_id
			   FROM messages source
			   JOIN messages m
			     ON m.conversation_id = source.conversation_id
			    AND (m.created_at < source.created_at OR (m.created_at = source.created_at AND m.id < source.id))
			   JOIN memory_message_heads h
			     ON h.conversation_id = m.conversation_id AND h.message_id = m.id
			  WHERE source.conversation_id = ? AND source.id = ?
			  ORDER BY m.created_at DESC, m.id DESC
			  LIMIT 1`
		)
		.get(conversationId, messageId) as { head_event_id: string | null } | undefined;
	return row?.head_event_id ?? null;
}

/**
 * Run `read` against the projection as it was at the START of the turn that owns
 * `assistantMessageId` — i.e. with that turn's own committed memory rolled away
 * — then restore the live projection. This is the forward-replay model, not a
 * backward undo: we re-root the projection at the turn's branch-point head and
 * replay the event log forward to it (so supersede/dedupe are re-derived
 * correctly), never appending any compensating "undo" events. The whole thing
 * runs inside a SAVEPOINT that is rolled back, so the event log and live
 * projection are left exactly as they were — only the transient read sees the
 * pre-turn view.
 *
 * The extraction-retry path uses this so the re-extractor sees memory as it was
 * before the turn ran, instead of its own prior committed output (which it would
 * otherwise treat as already-recorded and skip). It is fully synchronous — the
 * savepoint is opened, used, and rolled back within one call, never held across
 * the async extraction — so it sidesteps the "transaction across awaits" problem.
 *
 * The savepoint name is per-call unique so a nested/re-entrant `read` (which
 * would open its own savepoint of the same name) can't make this call's
 * `ROLLBACK TO` target the inner savepoint instead of its own.
 */
let turnStartViewSavepointSeq = 0;
export function readMemoryAtTurnStart<T>(
	conversationId: string | number,
	assistantMessageId: string | number,
	read: () => T
): T {
	const db = getDb();
	const intConv = convInt(conversationId);
	const savepoint = `memory_turn_start_view_${turnStartViewSavepointSeq++}`;
	db.exec(`SAVEPOINT ${savepoint}`);
	try {
		const intMessageId =
			typeof assistantMessageId === 'number'
				? assistantMessageId
				: messageId.parse(assistantMessageId);
		const branchPoint = headBeforeMessage(db, intConv, intMessageId);
		rebuildSessionMemoryProjectionInTransaction(db, intConv, branchPoint);
		return read();
	} finally {
		// Discard the transient re-projection (and its head move); the materialized
		// packet `read` returned is plain JS objects, so it survives the rollback.
		db.exec(`ROLLBACK TO ${savepoint}`);
		db.exec(`RELEASE ${savepoint}`);
	}
}

export function wipe(conversationId: string | number): void {
	const db = getDb();
	const intConv = convInt(conversationId);
	const tx = db.transaction(() => {
		clearSessionMemoryProjection(db, intConv);
		db.prepare('DELETE FROM memory_event_log WHERE conversation_id = ?').run(intConv);
		db.prepare('DELETE FROM memory_refs WHERE conversation_id = ?').run(intConv);
		db.prepare('DELETE FROM memory_heads WHERE conversation_id = ?').run(intConv);
		db.prepare('DELETE FROM memory_message_heads WHERE conversation_id = ?').run(intConv);
	});
	tx();
}

// Retention: cap the per-conversation `memory_event_log` (and the FTS index it
// feeds) by trimming the oldest events on the reachable chain.
//
// The log is append-only and the live projection is a full fold over the chain;
// crucially each event payload carries a *full snapshot* of its item, not a
// delta. So keeping only the most recent `maxEvents` events and re-rooting the
// chain at the oldest survivor (parent_id -> NULL) yields a projection rebuild
// that still reconstructs every surviving item's latest state — the only thing
// lost is "cold" history (items whose sole observation aged out), which is
// exactly the intent of a retention sweep. Returns the number of events trimmed.
export function compactSessionMemoryLog(
	conversationId: string | number,
	maxEvents: number
): number {
	if (!Number.isFinite(maxEvents) || maxEvents <= 0) return 0;
	const cap = Math.floor(maxEvents);
	const db = getDb();
	const intConv = convInt(conversationId);
	let trimmed = 0;
	const tx = db.transaction(() => {
		const head = getCurrentMemoryHead(db, intConv);
		const chain = chainRowsForHead(db, intConv, head); // root -> head
		if (chain.length <= cap) return;
		const purged = chain.slice(0, chain.length - cap);
		const newRoot = chain[chain.length - cap];

		const deleteEvent = db.prepare(
			'DELETE FROM memory_event_log WHERE conversation_id = ? AND id = ?'
		);
		const deleteRefBySource = db.prepare('DELETE FROM memory_refs WHERE source_key = ?');
		const deleteRefByTarget = db.prepare(
			'DELETE FROM memory_refs WHERE conversation_id = ? AND target_event_id = ?'
		);
		const deleteMessageHead = db.prepare(
			'DELETE FROM memory_message_heads WHERE conversation_id = ? AND head_event_id = ?'
		);
		for (const row of purged) {
			deleteRefBySource.run(row.id);
			deleteRefByTarget.run(intConv, row.id);
			deleteMessageHead.run(intConv, row.id);
			deleteEvent.run(intConv, row.id);
		}

		// Re-root: the oldest survivor's parent has just been removed, so detach it
		// and drop its now-dangling outgoing parent reference. chainRowsForHead then
		// terminates cleanly at this event on the next rebuild.
		db.prepare(
			'UPDATE memory_event_log SET parent_id = NULL WHERE conversation_id = ? AND id = ?'
		).run(intConv, newRoot.id);
		deleteRefBySource.run(newRoot.id);

		// Rebuild the projection + FTS index from the capped chain so the live state
		// (and search) reflect exactly the retained events.
		rebuildSessionMemoryProjectionInTransaction(db, intConv);
		trimmed = purged.length;
	});
	tx();
	return trimmed;
}

// Sweep every conversation whose event log exceeds `maxEvents` and compact it.
// `maxEvents <= 0` disables retention (no-op). Returns how many conversations
// were trimmed and the total events removed.
export function runMemoryRetention(opts: { maxEvents: number }): {
	conversations: number;
	trimmed: number;
} {
	if (!Number.isFinite(opts.maxEvents) || opts.maxEvents <= 0) {
		return { conversations: 0, trimmed: 0 };
	}
	const cap = Math.floor(opts.maxEvents);
	const db = getDb();
	const rows = db
		.prepare(
			`SELECT conversation_id AS id
			   FROM memory_event_log
			  GROUP BY conversation_id
			 HAVING COUNT(*) > ?`
		)
		.all(cap) as { id: number }[];
	let conversations = 0;
	let trimmed = 0;
	for (const row of rows) {
		const removed = compactSessionMemoryLog(row.id, cap);
		if (removed > 0) {
			conversations += 1;
			trimmed += removed;
		}
	}
	return { conversations, trimmed };
}

// Reclaim the disk pages freed by retention (and any other deletes). VACUUM
// rewrites the database file, so it runs outside any transaction and is reserved
// for the periodic maintenance task rather than the hot path.
export function vacuumMemoryDatabase(): void {
	const db = getDb();
	db.exec('VACUUM');
}

export function rebuildSessionMemoryProjection(conversationId: string | number): void {
	const db = getDb();
	const intConv = convInt(conversationId);
	const tx = db.transaction(() => rebuildSessionMemoryProjectionInTransaction(db, intConv));
	tx();
}

function countSessionProjectionRows(
	db: Database.Database,
	table: SessionProjectionTable,
	conversationId: number,
	status: string | null
): number {
	const row = (
		status
			? db
					.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE conversation_id = ? AND status = ?`)
					.get(conversationId, status)
			: db
					.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE conversation_id = ?`)
					.get(conversationId)
	) as { n: number };
	return row.n;
}

// Table that backs each session-memory item type, for the fork remapper's
// MAX(id)+1 seed. Restricted to a fixed Record so the interpolated table name
// can never be user-controlled (mirrors the SessionProjectionTable pattern).
const REMAPPER_TABLES: Record<string, string> = {
	entity: 'memory_entities',
	event: 'memory_events',
	fact: 'memory_facts',
	open_loop: 'memory_open_loops',
	patch: 'memory_patches',
	patch_item: 'memory_patch_items',
	issue: 'memory_validation_issues',
	tool_call: 'memory_tool_calls'
};

function getMaxRemapperId(db: Database.Database, type: string): number | undefined {
	const table = REMAPPER_TABLES[type];
	if (!table) return undefined;
	const row = db.prepare(`SELECT MAX(id) AS m FROM ${table}`).get() as { m: number | null };
	return row?.m ?? undefined;
}

function createForkMemoryRemapper(
	targetConversationId: number,
	messageIdMap: Map<number, number>,
	isCopied: (type: string, id: number) => boolean
): (itemType: SessionMemoryLogItemType, payload: unknown) => unknown {
	const db = getDb();
	// Fork-local id minting. Projection tables (memory_entities & co) have
	// GLOBALLY-unique primary keys shared by every conversation, so a fork's ids
	// must clear every other conversation's ids: seed each type's counter from
	// MAX(id)+1 across the whole table, then hand out ascending ids. AUTOINCREMENT
	// continues above the highest explicitly-inserted id, so a fork can never
	// collide with (or shadow) a future insert. better-sqlite3 is single-connection
	// and this runs inside a transaction, so there are no races.
	const idMaps = new Map<string, Map<number, number>>();
	const nextId = new Map<string, number>();
	// Normalize a payload id to its int form (handles parse; ints pass through).
	const toInt = (type: string, id: unknown): number | null => {
		const codec = codecFor(type);
		return codec ? toIntId(id, codec) : typeof id === 'number' ? id : null;
	};
	// Encode a fork-local int back to the wire form the type uses.
	const enc = (type: string, id: number): string | number => {
		const codec = codecFor(type);
		return codec ? codec.encode(id) : id;
	};
	// Mint (or reuse) the fork-local INT id for an item that IS being copied.
	// Used for each row's own primary id (callers re-encode with `enc`).
	const mintId = (type: string, id: unknown): number | null => {
		const intId = toInt(type, id);
		if (!intId) return null;
		let typeMap = idMaps.get(type);
		if (!typeMap) {
			typeMap = new Map();
			idMaps.set(type, typeMap);
			nextId.set(type, (getMaxRemapperId(db, type) ?? 0) + 1);
		}
		let next = typeMap.get(intId);
		if (next === undefined) {
			next = nextId.get(type)!;
			nextId.set(type, next + 1);
			typeMap.set(intId, next);
		}
		return next;
	};
	// Resolve a reference to another item, returning the fork-local id in the
	// referenced type's wire form (handle or int). Returns null only when the
	// referenced item was not itself copied, so links to rows left behind by the
	// fork never dangle at a non-existent id.
	const refId = (type: string, id: unknown): string | number | null => {
		const intId = toInt(type, id);
		if (!intId || !isCopied(type, intId)) return null;
		const minted = mintId(type, intId);
		return minted === null ? null : enc(type, minted);
	};
	// Like `refId` but always yields the raw INT — for kind-scoped reference
	// columns (patch_item.itemId, patchId) that stay integers.
	const refIntId = (type: string, id: number | null | undefined): number | null => {
		if (!id || !isCopied(type, id)) return null;
		return mintId(type, id);
	};
	const mapMessage = (id: unknown): string | null => {
		const intId = toIntId(id, messageId);
		if (!intId) return null;
		const mapped = messageIdMap.get(intId);
		return mapped === undefined ? null : messageId.encode(mapped);
	};
	const targetConv = conversationId.encode(targetConversationId);
	const remapItem = (itemType: SessionMemoryLogItemType, value: unknown): unknown => {
		if (!value || typeof value !== 'object') return value;
		if (itemType === 'entity') {
			const item = value as MemoryEntity;
			return { ...item, id: enc('entity', mintId('entity', item.id)!), conversationId: targetConv };
		}
		if (itemType === 'event') {
			const item = value as MemoryEvent;
			return {
				...item,
				id: mintId('event', item.id),
				conversationId: targetConv,
				turnId: null,
				actorEntityId: refId('entity', item.actorEntityId) as string | null,
				targetEntityId: refId('entity', item.targetEntityId) as string | null,
				sourceMessageId: mapMessage(item.sourceMessageId),
				sourceToolCallId: null
			};
		}
		if (itemType === 'fact') {
			const item = value as MemoryFact;
			return {
				...item,
				id: enc('fact', mintId('fact', item.id)!),
				conversationId: targetConv,
				entityId: refId('entity', item.entityId) as string | null,
				sourceEventId: refId('event', item.sourceEventId) as number | null,
				sourceMessageId: mapMessage(item.sourceMessageId),
				supersedesFactId: refId('fact', item.supersedesFactId) as string | null
			};
		}
		if (itemType === 'open_loop') {
			const item = value as MemoryOpenLoop;
			return {
				...item,
				id: mintId('open_loop', item.id),
				conversationId: targetConv,
				relatedEntityIds: item.relatedEntityIds
					.map((id) => refId('entity', id))
					.filter((id): id is string => typeof id === 'string'),
				sourceEventId: refId('event', item.sourceEventId) as number | null,
				sourceMessageId: mapMessage(item.sourceMessageId)
			};
		}
		if (itemType === 'patch') {
			const patch = value as MemoryPatch;
			return {
				...patch,
				id: mintId('patch', patch.id),
				conversationId: targetConv,
				turnId: null
			};
		}
		if (itemType === 'patch_item') {
			const item = value as MemoryPatchItem;
			return {
				...item,
				id: enc('patch_item', mintId('patch_item', item.id)!),
				patchId: refIntId('patch', item.patchId) ?? item.patchId,
				conversationId: targetConv,
				itemId: refIntId(item.itemType, patchItemTargetId(item)) ?? item.itemId
			};
		}
		if (itemType === 'issue') {
			const issue = value as MemoryValidationIssue;
			return {
				...issue,
				id: mintId('issue', issue.id),
				conversationId: targetConv,
				patchId: refIntId('patch', issue.patchId) ?? issue.patchId
			};
		}
		if (itemType === 'tool_call') {
			const toolCall = value as MemoryToolCall;
			return {
				...toolCall,
				id: mintId('tool_call', toolCall.id),
				conversationId: targetConv,
				turnId: null
			};
		}
		// Unknown/legacy item types (e.g. retired `decision` log rows on old
		// conversations) are copied verbatim. They have no live projection, so
		// the replayed entry is a silent no-op rather than being mis-minted as a
		// tool call.
		return value;
	};
	return (itemType, payload) => {
		const record = payloadObject(payload);
		const result: Record<string, unknown> = { ...record };
		if ('item' in result) result.item = remapItem(itemType, result.item);
		if ('patch' in result) result.patch = remapItem('patch', result.patch);
		if ('issue' in result) result.issue = remapItem('issue', result.issue);
		if ('toolCall' in result) result.toolCall = remapItem('tool_call', result.toolCall);
		// A liveness event references open loops by id in its presented/kept
		// arrays; remap them to the fork-local loop ids and drop any whose loop
		// was not copied, so the replayed decay still targets the right rows.
		if (itemType === 'open_loop_liveness') {
			const remapLoopIds = (value: unknown): number[] =>
				Array.isArray(value)
					? value
							.map((id) => (typeof id === 'number' ? refIntId('open_loop', id) : null))
							.filter((id): id is number => id !== null)
					: [];
			result.presented = remapLoopIds(result.presented);
			result.kept = remapLoopIds(result.kept);
		}
		return result;
	};
}

function remapIdForPayload(itemType: string, sourceItemId: number, payload: unknown): number {
	const record = payloadObject(payload);
	const value = (record.item ?? record.patch ?? record.issue ?? record.toolCall) as
		| { id?: unknown }
		| undefined;
	if (value?.id === undefined) return sourceItemId;
	const codec = codecFor(itemType);
	const parsed = codec ? toIntId(value.id, codec) : typeof value.id === 'number' ? value.id : null;
	return parsed ?? sourceItemId;
}

export function replaySessionMemoryLogForFork(
	sourceConversationId: number,
	targetConversationId: number,
	opts: { messageIdMap: Map<number, number>; createdBefore?: number | undefined }
): { entities: number; events: number; facts: number; openLoops: number } {
	const db = getDb();
	const included = new Set<string>();
	const isIncluded = (type: string, id: number) => included.has(`${type}:${id}`);
	const markIncluded = (type: string, id: number) => included.add(`${type}:${id}`);
	const counts = { entities: 0, events: 0, facts: 0, openLoops: 0 };
	const tx = db.transaction(() => {
		clearSessionMemoryProjection(db, targetConversationId);
		db.prepare('DELETE FROM memory_event_log WHERE conversation_id = ?').run(targetConversationId);
		db.prepare('DELETE FROM memory_refs WHERE conversation_id = ?').run(targetConversationId);
		db.prepare('DELETE FROM memory_heads WHERE conversation_id = ?').run(targetConversationId);
		db.prepare('DELETE FROM memory_message_heads WHERE conversation_id = ?').run(
			targetConversationId
		);
		const sourceHead = headForMessagePrefix(db, sourceConversationId, opts.messageIdMap.keys(), {
			createdBefore: opts.createdBefore
		});
		const copied = chainRowsForHead(db, sourceConversationId, sourceHead);
		for (const row of copied) {
			markIncluded(row.item_type, row.item_id);
		}
		const remap = createForkMemoryRemapper(targetConversationId, opts.messageIdMap, isIncluded);
		for (const row of copied) {
			const payload = parseJson(row.payload_json, {});
			const transformed = remap(row.item_type, payload);
			const targetItemId = remapIdForPayload(row.item_type, row.item_id, transformed);
			appendSessionMemoryLog(db, targetConversationId, {
				eventKind: row.event_kind,
				itemType: row.item_type,
				itemId: targetItemId,
				sourceMessageId: row.source_message_id
					? (opts.messageIdMap.get(row.source_message_id) ?? null)
					: null,
				turnId: null,
				payload: transformed,
				createdAt: row.created_at
			});
		}
		rebuildSessionMemoryProjectionInTransaction(db, targetConversationId);
		counts.entities = countSessionProjectionRows(
			db,
			'memory_entities',
			targetConversationId,
			'active'
		);
		counts.events = countSessionProjectionRows(db, 'memory_events', targetConversationId, null);
		counts.facts = countSessionProjectionRows(db, 'memory_facts', targetConversationId, 'active');
		counts.openLoops = countSessionProjectionRows(
			db,
			'memory_open_loops',
			targetConversationId,
			'open'
		);
	});
	tx();
	return counts;
}

export function rewindSessionMemoryLogToMessagePrefix(
	conversationId: number,
	opts: { messageIds: Set<number>; createdBefore?: number | undefined }
): { kept: number; removed: number } {
	const db = getDb();
	let kept = 0;
	let removed = 0;
	const tx = db.transaction(() => {
		const currentHead = getCurrentMemoryHead(db, conversationId);
		const nextHead = headForMessagePrefix(db, conversationId, opts.messageIds, {
			createdBefore: opts.createdBefore
		});
		kept = chainRowsForHead(db, conversationId, nextHead).length;
		removed = Math.max(0, chainRowsForHead(db, conversationId, currentHead).length - kept);
		// Drop memory heads for the messages that are about to be truncated away.
		// The suffix events they pinned then become unreferenced and are GC'd by
		// walking back from the old tip until we reach the kept prefix head.
		const keptMessageIds = new Set(opts.messageIds);
		const headRows = db
			.prepare('SELECT message_id FROM memory_message_heads WHERE conversation_id = ?')
			.all(conversationId) as { message_id: number }[];
		for (const row of headRows) {
			if (!keptMessageIds.has(row.message_id)) {
				dropMemoryMessageHead(db, conversationId, row.message_id);
			}
		}
		gcMemoryEventChain(db, conversationId, currentHead);
		rebuildSessionMemoryProjectionInTransaction(db, conversationId, nextHead);
	});
	tx();
	return { kept, removed };
}
