import type Database from 'better-sqlite3';
import { ulid } from '../../ids';
import { getDb } from '../../index';
import {
	conversationId,
	memoryEntityId,
	memoryFactId,
	memoryPatchItemId,
	messageId,
	messageId as msgCodec,
	toolCallId
} from '$lib/ids';
import { normalizeMemoryMode, type MemoryMode } from '$lib/types';
import {
	convInt,
	parseJson,
	patchItemTargetId,
	safeJson,
	toIntId,
	type EntityRow,
	type EventRow,
	type FactRow,
	type MemoryEntity,
	type MemoryEvent,
	type MemoryFact,
	type MemoryLogRow,
	type MemoryOpenLoop,
	type MemoryPatch,
	type MemoryPatchItem,
	type MemoryToolCall,
	type MemoryValidationIssue,
	type OpenLoopRow,
	type SessionMemoryLogItemType
} from './rows';
import {
	entityIndexText,
	eventIndexText,
	factIndexText,
	indexItem,
	openLoopIndexText,
	syncSessionIndex
} from './search';

/**
 * Predicates whose values form a SET that accumulates — a character can have
 * many `trait`s, `owns` many things, etc. — so distinct values coexist and only
 * identical re-observations are deduped.
 *
 * Every OTHER predicate is single-valued: it holds one current value per entity,
 * so re-asserting the same entity+predicate with a new value supersedes the
 * prior one in place. This is the documented attribute contract ("attribute
 * facts supersede in place — re-asserting one retires the prior value
 * automatically", docs/memory-backed-sessions.md) and it bounds memory growth at
 * the source for state-like facts (location, status, hair, mood, ...). Add a
 * predicate here only when its values are genuinely a collection, not a single
 * current value.
 */
const MULTI_VALUED_PREDICATES = new Set([
	// Standing rules are append-only: distinct directives coexist (identical text
	// is deduped). Keep in sync with engine's DIRECTIVE_PREDICATE.
	'directive',
	// Strict-mode mystery sessions accumulate many `clue` facts (one object per
	// clue) on the session entity, queried as a set by memory_query_clues.
	'clue',
	'trait',
	'owns',
	'item',
	'ability',
	'skill',
	'alias',
	'relationship',
	'knows',
	'tag'
]);

// Per-character knowledge is stored under dynamic `knowledge:<entityKey>`
// predicates (engine strict-mode validation + memory_get_character_knowledge),
// and a character accumulates many distinct knowledge items under the same
// predicate — so the whole family is collection-like, not single-valued.
const MULTI_VALUED_PREDICATE_PREFIXES = ['knowledge:'];

export function isMultiValuedPredicate(predicate: string): boolean {
	const normalized = predicate.toLowerCase();
	if (MULTI_VALUED_PREDICATES.has(normalized)) return true;
	return MULTI_VALUED_PREDICATE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function getMode(conversationId: string | number): MemoryMode {
	const row = getDb()
		.prepare('SELECT memory_mode FROM conversations WHERE id = ?')
		.get(convInt(conversationId)) as { memory_mode: string | null } | undefined;
	return normalizeMemoryMode(row?.memory_mode);
}

/**
 * Per-conversation extraction semaphore. Best-effort, single-holder advisory
 * lock backing the snapshot->commit window of memory extraction so concurrent
 * extractions for one conversation serialize rather than each snapshotting the
 * same pre-commit state and both appending. Returns true when the caller now
 * holds the lock.
 *
 * Acquisition is a single SQLite transaction: reap any expired holder (a
 * crashed/aborted extraction whose `expires_at` has passed), then attempt an
 * INSERT OR IGNORE and report whether the surviving row is ours. `ttlMs` bounds
 * how long a held lock survives without an explicit release so a conversation
 * can never deadlock forever.
 */
export function tryAcquireExtractionLock(
	conversationId: string | number,
	holder: string,
	opts: { ttlMs: number; now?: number }
): boolean {
	const intConv = convInt(conversationId);
	const now = opts.now ?? Date.now();
	const expiresAt = now + opts.ttlMs;
	const db = getDb();
	return db.transaction(() => {
		db.prepare(
			'DELETE FROM memory_extraction_locks WHERE conversation_id = ? AND expires_at <= ?'
		).run(intConv, now);
		db.prepare(
			`INSERT OR IGNORE INTO memory_extraction_locks(conversation_id, holder, acquired_at, expires_at)
			 VALUES (?, ?, ?, ?)`
		).run(intConv, holder, now, expiresAt);
		const row = db
			.prepare('SELECT holder FROM memory_extraction_locks WHERE conversation_id = ?')
			.get(intConv) as { holder: string } | undefined;
		return row?.holder === holder;
	})();
}

/**
 * Release a lock previously taken with {@link tryAcquireExtractionLock}. Scoped
 * to the holder token so a caller can never drop a lock another holder took
 * over after its own row expired.
 */
export function releaseExtractionLock(conversationId: string | number, holder: string): void {
	getDb()
		.prepare('DELETE FROM memory_extraction_locks WHERE conversation_id = ? AND holder = ?')
		.run(convInt(conversationId), holder);
}

/**
 * Derive the active set for one (entity, predicate) group in the projection.
 * This is the single home of consolidation, called from every path that mutates
 * a fact (imperative writes, edits/deletes, and event-stream replay) so the same
 * rule is applied whether facts arrive live or are rebuilt from the log:
 *
 *   - multi-valued predicates (trait, owns, ...): the newest observation of each
 *     distinct value stays active; older identical observations become
 *     `superseded` (dedupe only — distinct values accumulate).
 *   - every other predicate is single-valued: only the newest observation in the
 *     group stays active and older ones become `superseded`, so re-asserting the
 *     same entity+predicate with a new value supersedes the prior value in place.
 *
 * Because it operates purely on the projected rows (never emitting events), a
 * projection rebuilt from a stream that omits some observations — e.g. after the
 * facts a patch created are deleted — re-derives the correct active set
 * without any reference counting or supersede bookkeeping.
 */
export function consolidateFactGroup(
	db: Database.Database,
	conversationId: number,
	entityId: number | null,
	predicate: string
): void {
	const rows = db
		.prepare(
			`SELECT * FROM memory_facts
			  WHERE conversation_id = ? AND predicate = ? AND status != 'deleted'
			    AND ((entity_id IS NULL AND ? IS NULL) OR entity_id = ?)
			  ORDER BY created_at ASC, id ASC`
		)
		.all(conversationId, predicate, entityId, entityId) as FactRow[];
	if (rows.length === 0) return;

	const activeIds = new Set<number>();
	if (isMultiValuedPredicate(predicate)) {
		// Newest row wins per distinct value (later rows overwrite the map entry).
		const newestByValue = new Map<string, number>();
		for (const row of rows) newestByValue.set(row.value_json, row.id);
		for (const id of newestByValue.values()) activeIds.add(id);
	} else {
		activeIds.add(rows[rows.length - 1].id);
	}

	const now = Date.now();
	for (const row of rows) {
		const desired = activeIds.has(row.id) ? 'active' : 'superseded';
		if (row.status === desired) continue;
		db.prepare('UPDATE memory_facts SET status = ?, updated_at = ? WHERE id = ?').run(
			desired,
			now,
			row.id
		);
		syncSessionIndex(db, conversationId, 'fact', row.id, desired, factIndexText(row));
	}
}

export interface OpenLoopLivenessPayload {
	presented?: unknown;
	kept?: unknown;
	baseThreshold?: unknown;
}

/**
 * Apply a single liveness pass to the open-loop projection rows. Pure function
 * of (current projection state, payload): reset kept loops to idle 0, increment
 * the rest, and auto-drop any that cross their effective threshold. Invoked both
 * on the live write path and during projection replay, so the two always agree.
 * Returns the ids dropped by this pass.
 */
export function applyOpenLoopLivenessProjection(
	db: Database.Database,
	conversationId: number,
	payload: OpenLoopLivenessPayload
): number[] {
	const presented = Array.isArray(payload.presented) ? (payload.presented as number[]) : [];
	const baseThreshold = typeof payload.baseThreshold === 'number' ? payload.baseThreshold : 0;
	if (presented.length === 0 || baseThreshold <= 0) return [];
	const kept = new Set(Array.isArray(payload.kept) ? (payload.kept as number[]) : []);
	const dropped: number[] = [];
	for (const id of presented) {
		const row = db
			.prepare('SELECT * FROM memory_open_loops WHERE id = ? AND conversation_id = ?')
			.get(id, conversationId) as OpenLoopRow | undefined;
		// Only age loops that are still open; a loop closed earlier in this same
		// replay (or this turn) is out of the open set and left untouched.
		if (!row || row.status !== 'open') continue;
		if (kept.has(id)) {
			if (row.idle_turns !== 0) {
				db.prepare(
					'UPDATE memory_open_loops SET idle_turns = 0 WHERE id = ? AND conversation_id = ?'
				).run(id, conversationId);
			}
			continue;
		}
		const next = row.idle_turns + 1;
		// Higher-priority loops linger proportionally longer before aging out.
		const effectiveThreshold = baseThreshold + Math.max(0, row.priority);
		if (next >= effectiveThreshold) {
			const note = `[auto-dropped] untouched by the extractor for ${next} passes`;
			const description = row.description ? `${row.description}\n${note}` : note;
			db.prepare(
				`UPDATE memory_open_loops
				    SET status = 'dropped', description = ?, idle_turns = ?, updated_at = ?
				  WHERE id = ? AND conversation_id = ?`
			).run(description, next, Date.now(), id, conversationId);
			const updated = db
				.prepare('SELECT * FROM memory_open_loops WHERE id = ? AND conversation_id = ?')
				.get(id, conversationId) as OpenLoopRow;
			syncSessionIndex(db, conversationId, 'open_loop', id, 'dropped', openLoopIndexText(updated));
			dropped.push(id);
		} else {
			db.prepare(
				'UPDATE memory_open_loops SET idle_turns = ? WHERE id = ? AND conversation_id = ?'
			).run(next, id, conversationId);
		}
	}
	return dropped;
}

export function payloadObject(payload: unknown): Record<string, unknown> {
	return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
}

export function getCurrentMemoryHead(db: Database.Database, conversationId: number): string | null {
	const row = db
		.prepare(
			`SELECT h.head_event_id
			   FROM messages m
			   JOIN memory_message_heads h
			     ON h.conversation_id = m.conversation_id AND h.message_id = m.id
			  WHERE m.conversation_id = ?
			  ORDER BY m.created_at DESC, m.id DESC
			  LIMIT 1`
		)
		.get(conversationId) as { head_event_id: string | null } | undefined;
	if (row) return row.head_event_id;
	const messageCount = db
		.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?')
		.get(conversationId) as { n: number };
	if (messageCount.n > 0) return null;
	return getProjectionMemoryHead(db, conversationId);
}

export function getProjectionMemoryHead(
	db: Database.Database,
	conversationId: number
): string | null {
	const row = db
		.prepare('SELECT projection_event_id FROM memory_heads WHERE conversation_id = ?')
		.get(conversationId) as { projection_event_id: string | null } | undefined;
	return row?.projection_event_id ?? null;
}

export function getLatestMessageId(db: Database.Database, conversationId: number): number | null {
	const row = db
		.prepare(
			`SELECT id
			   FROM messages
			  WHERE conversation_id = ?
			  ORDER BY created_at DESC, id DESC
			  LIMIT 1`
		)
		.get(conversationId) as { id: number } | undefined;
	return row?.id ?? null;
}

export function getAppendParentMemoryHead(
	db: Database.Database,
	conversationId: number,
	sourceMessageId: number | null | undefined
): string | null {
	if (sourceMessageId) {
		const row = db
			.prepare(
				`SELECT h.head_event_id
				   FROM messages source
				   JOIN messages m
				     ON m.conversation_id = source.conversation_id
				    AND (m.created_at < source.created_at OR (m.created_at = source.created_at AND m.id <= source.id))
				   JOIN memory_message_heads h
				     ON h.conversation_id = m.conversation_id AND h.message_id = m.id
				  WHERE source.conversation_id = ? AND source.id = ?
				  ORDER BY m.created_at DESC, m.id DESC
				  LIMIT 1`
			)
			.get(conversationId, sourceMessageId) as { head_event_id: string | null } | undefined;
		if (row) return row.head_event_id;
	}
	return getCurrentMemoryHead(db, conversationId);
}

export function setProjectionMemoryHead(
	db: Database.Database,
	conversationId: number,
	headEventId: string | null
): void {
	db.prepare(
		`INSERT INTO memory_heads(conversation_id, projection_event_id, updated_at)
		 VALUES (?, ?, ?)
		 ON CONFLICT(conversation_id) DO UPDATE SET
		   projection_event_id = excluded.projection_event_id,
		   updated_at = excluded.updated_at`
	).run(conversationId, headEventId, Date.now());
}

type MemoryRefKind = 'memory_parent' | 'message_head';

// Upsert an incoming reference (source_key -> target_event_id). Returns the
// previously referenced event id when the target moved, so the caller can GC
// the event that just lost this reference. Returns null when unchanged.
function setMemoryRef(
	db: Database.Database,
	conversationId: number,
	kind: MemoryRefKind,
	sourceKey: string | number,
	targetEventId: string
): string | null {
	// source_key is TEXT (message ids and event ids share the column); store a
	// canonical string so integer ids never surface as the "1.0" REAL artifact.
	const key = String(sourceKey);
	const prev = db
		.prepare('SELECT target_event_id FROM memory_refs WHERE ref_kind = ? AND source_key = ?')
		.get(kind, key) as { target_event_id: string } | undefined;
	db.prepare(
		`INSERT INTO memory_refs(conversation_id, ref_kind, source_key, target_event_id, created_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(ref_kind, source_key) DO UPDATE SET
		   conversation_id = excluded.conversation_id,
		   target_event_id = excluded.target_event_id,
		   created_at = excluded.created_at`
	).run(conversationId, kind, key, targetEventId, Date.now());
	return prev && prev.target_event_id !== targetEventId ? prev.target_event_id : null;
}

// Remove an incoming reference. Returns the event id it pointed at (if any) so
// the caller can GC it.
function dropMemoryRef(
	db: Database.Database,
	kind: MemoryRefKind,
	sourceKey: string | number
): string | null {
	const key = String(sourceKey);
	const prev = db
		.prepare('SELECT target_event_id FROM memory_refs WHERE ref_kind = ? AND source_key = ?')
		.get(kind, key) as { target_event_id: string } | undefined;
	db.prepare('DELETE FROM memory_refs WHERE ref_kind = ? AND source_key = ?').run(kind, key);
	return prev?.target_event_id ?? null;
}

function memoryEventIsReferenced(db: Database.Database, eventId: string): boolean {
	const row = db
		.prepare('SELECT 1 AS ok FROM memory_refs WHERE target_event_id = ? LIMIT 1')
		.get(eventId) as { ok: number } | undefined;
	return row !== undefined;
}

// Backward garbage-collect from `startEventId`: while the event has no incoming
// references, delete it (dropping its own outgoing parent reference) and walk
// to its parent, which may in turn become unreferenced. Cycles are impossible
// by construction (parents are always older), but a depth guard keeps a buggy
// chain from looping forever.
export function gcMemoryEventChain(
	db: Database.Database,
	conversationId: number,
	startEventId: string | null
): void {
	let id: string | null = startEventId;
	let guard = 0;
	while (id && guard++ < 1_000_000) {
		if (memoryEventIsReferenced(db, id)) break;
		const row = db
			.prepare('SELECT parent_id FROM memory_event_log WHERE conversation_id = ? AND id = ?')
			.get(conversationId, id) as { parent_id: string | null } | undefined;
		if (!row) break;
		dropMemoryRef(db, 'memory_parent', id);
		db.prepare('DELETE FROM memory_event_log WHERE conversation_id = ? AND id = ?').run(
			conversationId,
			id
		);
		id = row.parent_id;
	}
}

function recordMemoryMessageHead(
	db: Database.Database,
	conversationId: number,
	messageId: number,
	headEventId: string
): void {
	db.prepare(
		`INSERT INTO memory_message_heads(conversation_id, message_id, head_event_id, updated_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(conversation_id, message_id) DO UPDATE SET
		   head_event_id = excluded.head_event_id,
		   updated_at = excluded.updated_at`
	).run(conversationId, messageId, headEventId, Date.now());
	// Mirror the move into the generic reference table for GC reachability and
	// reclaim the event this message previously pinned if nothing else holds it.
	const orphaned = setMemoryRef(
		db,
		conversationId,
		'message_head',
		msgCodec.encode(messageId),
		headEventId
	);
	if (orphaned) gcMemoryEventChain(db, conversationId, orphaned);
}

// Drop the memory head for a message that is being removed (inline edit /
// rerun truncation), then GC whatever its reference was pinning.
export function dropMemoryMessageHead(
	db: Database.Database,
	conversationId: number,
	messageId: number
): void {
	db.prepare('DELETE FROM memory_message_heads WHERE conversation_id = ? AND message_id = ?').run(
		conversationId,
		messageId
	);
	const orphaned = dropMemoryRef(db, 'message_head', msgCodec.encode(messageId));
	if (orphaned) gcMemoryEventChain(db, conversationId, orphaned);
}

export function headForMessagePrefix(
	db: Database.Database,
	conversationId: number,
	messageIds: Iterable<number>,
	opts: { createdBefore?: number | undefined } = {}
): string | null {
	const ids = new Set(messageIds);
	let head: string | null = null;
	for (const messageId of ids) {
		const row = db
			.prepare(
				`SELECT h.head_event_id
				   FROM messages m
				   JOIN memory_message_heads h
				     ON h.conversation_id = m.conversation_id AND h.message_id = m.id
				  WHERE m.conversation_id = ? AND m.id = ?`
			)
			.get(conversationId, messageId) as { head_event_id: string | null } | undefined;
		if (row) head = row.head_event_id;
	}
	if (!head && opts.createdBefore !== undefined) {
		const row = db
			.prepare(
				`SELECT id
				   FROM memory_event_log
				  WHERE conversation_id = ? AND created_at <= ?
				  ORDER BY seq DESC
				  LIMIT 1`
			)
			.get(conversationId, opts.createdBefore) as { id: string } | undefined;
		head = row?.id ?? null;
	}
	return head;
}

export function chainRowsForHead(
	db: Database.Database,
	conversationId: number,
	headId: string | null
): MemoryLogRow[] {
	const rows: MemoryLogRow[] = [];
	let id = headId;
	while (id) {
		const row = db
			.prepare('SELECT * FROM memory_event_log WHERE conversation_id = ? AND id = ?')
			.get(conversationId, id) as MemoryLogRow | undefined;
		if (!row) break;
		rows.push(row);
		id = row.parent_id;
	}
	return rows.reverse();
}

export function appendSessionMemoryLog(
	db: Database.Database,
	conversationId: number,
	input: {
		eventKind: string;
		itemType: SessionMemoryLogItemType;
		itemId: number;
		sourceMessageId?: number | null | undefined;
		turnId?: string | null | undefined;
		payload: unknown;
		createdAt?: number | undefined;
	}
): void {
	const now = input.createdAt ?? Date.now();
	const id = ulid();
	const parentId = getAppendParentMemoryHead(db, conversationId, input.sourceMessageId);
	db.prepare(
		`INSERT INTO memory_event_log(
		   id, parent_id, conversation_id, event_kind, item_type, item_id, source_message_id,
		   turn_id, payload_json, created_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		id,
		parentId,
		conversationId,
		input.eventKind,
		input.itemType,
		input.itemId,
		input.sourceMessageId ?? null,
		input.turnId ?? null,
		safeJson(input.payload),
		now
	);
	if (parentId) {
		setMemoryRef(db, conversationId, 'memory_parent', id, parentId);
	}
	const projectionHead = getProjectionMemoryHead(db, conversationId);
	if (projectionHead !== parentId) {
		rebuildSessionMemoryProjectionInTransaction(db, conversationId, parentId);
		applySessionMemoryLogProjection(
			db,
			{
				seq: 0,
				id,
				parent_id: parentId,
				conversation_id: conversationId,
				event_kind: input.eventKind,
				item_type: input.itemType,
				item_id: input.itemId,
				source_message_id: input.sourceMessageId ?? null,
				turn_id: input.turnId ?? null,
				payload_json: safeJson(input.payload),
				created_at: now
			},
			input.payload
		);
		rebuildSessionMemoryIndexes(db, conversationId);
	}
	const headMessageId =
		input.sourceMessageId && messageBelongsToConversation(db, conversationId, input.sourceMessageId)
			? input.sourceMessageId
			: getLatestMessageId(db, conversationId);
	if (headMessageId) {
		recordMemoryMessageHead(db, conversationId, headMessageId, id);
	}
	const currentHead = headMessageId ? getCurrentMemoryHead(db, conversationId) : id;
	if (currentHead === id) {
		setProjectionMemoryHead(db, conversationId, id);
	} else {
		rebuildSessionMemoryProjectionInTransaction(db, conversationId, currentHead);
	}
}

function messageBelongsToConversation(
	db: Database.Database,
	conversationId: number,
	messageId: number
): boolean {
	const row = db
		.prepare('SELECT 1 AS ok FROM messages WHERE conversation_id = ? AND id = ?')
		.get(conversationId, messageId) as { ok: number } | undefined;
	return row !== undefined;
}

export function clearSessionMemoryProjection(db: Database.Database, conversationId: number): void {
	db.prepare('DELETE FROM memory_search_index WHERE conversation_id = ?').run(conversationId);
	db.prepare('DELETE FROM memory_patch_items WHERE conversation_id = ?').run(conversationId);
	db.prepare('DELETE FROM memory_tool_calls WHERE conversation_id = ?').run(conversationId);
	db.prepare('DELETE FROM memory_validation_issues WHERE conversation_id = ?').run(conversationId);
	db.prepare('DELETE FROM memory_patches WHERE conversation_id = ?').run(conversationId);
	db.prepare('DELETE FROM memory_open_loops WHERE conversation_id = ?').run(conversationId);
	db.prepare('DELETE FROM memory_facts WHERE conversation_id = ?').run(conversationId);
	db.prepare('DELETE FROM memory_events WHERE conversation_id = ?').run(conversationId);
	db.prepare('DELETE FROM memory_entities WHERE conversation_id = ?').run(conversationId);
}

export function rebuildSessionMemoryProjectionInTransaction(
	db: Database.Database,
	conversationId: number,
	headId: string | null = getCurrentMemoryHead(db, conversationId)
): void {
	clearSessionMemoryProjection(db, conversationId);
	const rows = chainRowsForHead(db, conversationId, headId);
	for (const row of rows) {
		applySessionMemoryLogProjection(db, row, parseJson(row.payload_json, {}));
	}
	rebuildSessionMemoryIndexes(db, conversationId);
	setProjectionMemoryHead(db, conversationId, headId);
}

function applySessionMemoryLogProjection(
	db: Database.Database,
	row: MemoryLogRow,
	payload: unknown
): void {
	const record = payloadObject(payload);
	if (row.item_type === 'entity') {
		const item = record.item as MemoryEntity | undefined;
		if (item) upsertEntityProjection(db, item);
	} else if (row.item_type === 'event') {
		const item = record.item as MemoryEvent | undefined;
		if (item) upsertEventProjection(db, item);
	} else if (row.item_type === 'fact') {
		const item = record.item as MemoryFact | undefined;
		if (item) {
			upsertFactProjection(db, item);
			// Re-derive the active set from the stream as it replays. Supersede /
			// dedupe is not stored on events, so a rebuild from the surviving
			// observations always yields the correct active facts.
			consolidateFactGroup(
				db,
				toIntId(item.conversationId, conversationId) ?? 0,
				toIntId(item.entityId, memoryEntityId),
				item.predicate
			);
		}
	} else if (row.item_type === 'open_loop') {
		const item = record.item as MemoryOpenLoop | undefined;
		if (item) upsertOpenLoopProjection(db, item);
	} else if (row.item_type === 'open_loop_liveness') {
		// Decay/drop is derived, not stored: replaying the liveness event
		// reconstructs idle counts and auto-drops, so fork/rewind stay faithful.
		applyOpenLoopLivenessProjection(db, row.conversation_id, record as OpenLoopLivenessPayload);
	} else if (row.item_type === 'patch') {
		const patch = record.patch as MemoryPatch | undefined;
		if (patch) upsertPatchProjection(db, patch);
	} else if (row.item_type === 'patch_item') {
		const item = record.item as MemoryPatchItem | undefined;
		if (item) upsertPatchItemProjection(db, item);
	} else if (row.item_type === 'issue') {
		const issue = record.issue as MemoryValidationIssue | undefined;
		if (issue) upsertIssueProjection(db, issue);
	} else if (row.item_type === 'tool_call') {
		const toolCall = record.toolCall as MemoryToolCall | undefined;
		if (toolCall) upsertToolCallProjection(db, toolCall);
	}
}

function rebuildSessionMemoryIndexes(db: Database.Database, conversationId: number): void {
	db.prepare('DELETE FROM memory_search_index WHERE conversation_id = ?').run(conversationId);
	for (const row of db
		.prepare(`SELECT * FROM memory_entities WHERE conversation_id = ?`)
		.all(conversationId) as EntityRow[]) {
		syncSessionIndex(db, conversationId, 'entity', row.id, row.status, entityIndexText(row));
	}
	for (const row of db
		.prepare(`SELECT * FROM memory_events WHERE conversation_id = ?`)
		.all(conversationId) as EventRow[]) {
		indexItem(db, conversationId, 'event', row.id, eventIndexText(row));
	}
	for (const row of db
		.prepare(`SELECT * FROM memory_facts WHERE conversation_id = ?`)
		.all(conversationId) as FactRow[]) {
		syncSessionIndex(db, conversationId, 'fact', row.id, row.status, factIndexText(row));
	}
	for (const row of db
		.prepare(`SELECT * FROM memory_open_loops WHERE conversation_id = ?`)
		.all(conversationId) as OpenLoopRow[]) {
		syncSessionIndex(db, conversationId, 'open_loop', row.id, row.status, openLoopIndexText(row));
	}
}

function upsertEntityProjection(db: Database.Database, item: MemoryEntity): void {
	db.prepare(
		`INSERT OR REPLACE INTO memory_entities(
		   id, conversation_id, entity_key, entity_type, display_name, summary, status,
		   metadata_json, created_at, updated_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		toIntId(item.id, memoryEntityId),
		toIntId(item.conversationId, conversationId),
		item.entityKey,
		item.entityType,
		item.displayName,
		item.summary,
		item.status,
		safeJson(item.metadata ?? {}),
		item.createdAt,
		item.updatedAt
	);
}

function upsertEventProjection(db: Database.Database, item: MemoryEvent): void {
	db.prepare(
		`INSERT OR REPLACE INTO memory_events(
		   id, conversation_id, turn_id, event_type, occurred_at, actor_entity_id,
		   target_entity_id, summary, payload_json, visibility, confidence,
		   source_message_id, source_tool_call_id, created_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		item.id,
		toIntId(item.conversationId, conversationId),
		item.turnId,
		item.eventType,
		item.occurredAt,
		toIntId(item.actorEntityId, memoryEntityId),
		toIntId(item.targetEntityId, memoryEntityId),
		item.summary,
		safeJson(item.payload ?? {}),
		item.visibility,
		item.confidence,
		toIntId(item.sourceMessageId, messageId),
		toIntId(item.sourceToolCallId, toolCallId),
		item.createdAt
	);
}

function upsertFactProjection(db: Database.Database, item: MemoryFact): void {
	db.prepare(
		`INSERT OR REPLACE INTO memory_facts(
		   id, conversation_id, entity_id, predicate, value_json, status, visibility,
		   confidence, source_event_id, source_message_id, supersedes_fact_id,
		   pinned, created_at, updated_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		toIntId(item.id, memoryFactId),
		toIntId(item.conversationId, conversationId),
		toIntId(item.entityId, memoryEntityId),
		item.predicate,
		safeJson(item.value),
		item.status,
		item.visibility,
		item.confidence,
		item.sourceEventId,
		toIntId(item.sourceMessageId, messageId),
		toIntId(item.supersedesFactId, memoryFactId),
		item.pinned ? 1 : 0,
		item.createdAt,
		item.updatedAt
	);
}

function upsertOpenLoopProjection(db: Database.Database, item: MemoryOpenLoop): void {
	db.prepare(
		`INSERT OR REPLACE INTO memory_open_loops(
		   id, conversation_id, loop_key, loop_type, title, description, status, priority,
		   related_entity_ids_json, source_event_id, source_message_id, created_at, updated_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		item.id,
		toIntId(item.conversationId, conversationId),
		item.loopKey ?? '',
		item.loopType,
		item.title,
		item.description,
		item.status,
		item.priority,
		safeJson(
			(item.relatedEntityIds ?? [])
				.map((id) => toIntId(id, memoryEntityId))
				.filter((id): id is number => id !== null && id > 0)
		),
		item.sourceEventId,
		toIntId(item.sourceMessageId, messageId),
		item.createdAt,
		item.updatedAt
	);
}

function upsertPatchProjection(db: Database.Database, patch: MemoryPatch): void {
	db.prepare(
		`INSERT OR REPLACE INTO memory_patches(
		   id, conversation_id, turn_id, status, summary, raw_patch_json,
		   validation_result_json, extractor_kind, extractor_model, extractor_confidence,
		   extractor_diagnostics_json, created_at, committed_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		patch.id,
		toIntId(patch.conversationId, conversationId),
		patch.turnId,
		patch.status,
		patch.summary,
		safeJson(patch.rawPatch ?? {}),
		safeJson(patch.validationResult ?? {}),
		patch.extractorKind,
		patch.extractorModel,
		patch.extractorConfidence,
		safeJson(patch.extractorDiagnostics ?? []),
		patch.createdAt,
		patch.committedAt
	);
}

function upsertPatchItemProjection(db: Database.Database, item: MemoryPatchItem): void {
	db.prepare(
		`INSERT OR REPLACE INTO memory_patch_items(
		   id, patch_id, conversation_id, item_type, item_id, action, review_status,
		   reviewed_at, created_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		toIntId(item.id, memoryPatchItemId),
		item.patchId,
		toIntId(item.conversationId, conversationId),
		item.itemType,
		patchItemTargetId(item),
		item.action,
		item.reviewStatus,
		item.reviewedAt,
		item.createdAt
	);
}

function upsertIssueProjection(db: Database.Database, issue: MemoryValidationIssue): void {
	db.prepare(
		`INSERT OR REPLACE INTO memory_validation_issues(
		   id, conversation_id, patch_id, severity, code, message, status, created_at, resolved_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		issue.id,
		toIntId(issue.conversationId, conversationId),
		issue.patchId,
		issue.severity,
		issue.code,
		issue.message,
		issue.status,
		issue.createdAt,
		issue.resolvedAt
	);
}

function upsertToolCallProjection(db: Database.Database, toolCall: MemoryToolCall): void {
	db.prepare(
		`INSERT OR REPLACE INTO memory_tool_calls(
		   id, conversation_id, turn_id, tool_name, arguments_json, result_summary,
		   result_ids_json, created_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		toolCall.id,
		toIntId(toolCall.conversationId, conversationId),
		toolCall.turnId,
		toolCall.toolName,
		safeJson(toolCall.arguments ?? {}),
		toolCall.resultSummary,
		safeJson(toolCall.resultIds ?? []),
		toolCall.createdAt
	);
}
