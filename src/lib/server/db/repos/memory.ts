import type Database from 'better-sqlite3';
import { ulid } from '../ids';
import { getDb } from '../index';
import { normalizeMemoryMode, type MemoryMode } from '$lib/types';

export type MemoryItemStatus = 'active' | 'superseded' | 'disputed' | 'deleted';
export type MemoryPatchStatus =
	| 'draft'
	| 'committed'
	| 'partially_committed'
	| 'rejected'
	| 'needs_review';

export interface MemoryEntity {
	id: string;
	conversationId: string;
	entityKey: string;
	entityType: string;
	displayName: string;
	summary: string;
	status: string;
	metadata: unknown;
	createdAt: number;
	updatedAt: number;
}

export interface MemoryEvent {
	id: string;
	conversationId: string;
	turnId: string | null;
	eventType: string;
	occurredAt: number;
	actorEntityId: string | null;
	targetEntityId: string | null;
	summary: string;
	payload: unknown;
	visibility: string;
	confidence: number;
	sourceMessageId: string | null;
	sourceToolCallId: string | null;
	createdAt: number;
}

export interface MemoryFact {
	id: string;
	conversationId: string;
	entityId: string | null;
	predicate: string;
	value: unknown;
	status: string;
	visibility: string;
	confidence: number;
	sourceEventId: string | null;
	sourceMessageId: string | null;
	supersedesFactId: string | null;
	pinned: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface MemoryOpenLoop {
	id: string;
	conversationId: string;
	/**
	 * Stable, human-legible handle (slug of the title, e.g. `loop.find_attic_key`),
	 * unique within a conversation. This is what the extractor sees and references
	 * to keep/close the loop, rather than the opaque ULID `id`. Empty for loops
	 * created before migration 039; resolution falls back to `id` in that case.
	 */
	loopKey: string;
	loopType: string;
	title: string;
	description: string;
	status: string;
	priority: number;
	relatedEntityIds: string[];
	sourceEventId: string | null;
	sourceMessageId: string | null;
	idleTurns: number;
	createdAt: number;
	updatedAt: number;
}

export interface MemoryPatch {
	id: string;
	conversationId: string;
	turnId: string | null;
	status: MemoryPatchStatus;
	summary: string;
	rawPatch: unknown;
	validationResult: unknown;
	extractorKind: string | null;
	extractorModel: string | null;
	extractorConfidence: number | null;
	extractorDiagnostics: unknown;
	createdAt: number;
	committedAt: number | null;
}

export interface MemoryValidationIssue {
	id: string;
	conversationId: string;
	patchId: string | null;
	severity: 'info' | 'warning' | 'error';
	code: string;
	message: string;
	status: string;
	createdAt: number;
	resolvedAt: number | null;
}

export interface MemoryToolCall {
	id: string;
	conversationId: string;
	turnId: string | null;
	toolName: string;
	arguments: unknown;
	resultSummary: string;
	resultIds: string[];
	createdAt: number;
}

export interface MemoryPatchItem {
	id: string;
	patchId: string;
	conversationId: string;
	itemType: string;
	itemId: string;
	action: string;
	reviewStatus: string;
	reviewedAt: number | null;
	createdAt: number;
}

interface MemoryLogRow {
	seq: number;
	id: string;
	parent_id: string | null;
	conversation_id: string;
	event_kind: string;
	item_type: SessionMemoryLogItemType;
	item_id: string;
	source_message_id: string | null;
	turn_id: string | null;
	payload_json: string;
	created_at: number;
}

type SessionMemoryLogItemType =
	| 'entity'
	| 'event'
	| 'fact'
	| 'open_loop'
	| 'open_loop_liveness'
	| 'patch'
	| 'patch_item'
	| 'issue'
	| 'tool_call';

export interface GlobalMemory {
	id: string;
	userId: string;
	kind: string;
	memoryKey: string;
	value: unknown;
	status: string;
	sourceConversationId: string | null;
	sourceMessageId: string | null;
	createdAt: number;
	updatedAt: number;
}

interface EntityRow {
	id: string;
	conversation_id: string;
	entity_key: string;
	entity_type: string;
	display_name: string;
	summary: string;
	status: string;
	metadata_json: string;
	created_at: number;
	updated_at: number;
}

interface EventRow {
	id: string;
	conversation_id: string;
	turn_id: string | null;
	event_type: string;
	occurred_at: number;
	actor_entity_id: string | null;
	target_entity_id: string | null;
	summary: string;
	payload_json: string;
	visibility: string;
	confidence: number;
	source_message_id: string | null;
	source_tool_call_id: string | null;
	created_at: number;
}

interface FactRow {
	id: string;
	conversation_id: string;
	entity_id: string | null;
	predicate: string;
	value_json: string;
	status: string;
	visibility: string;
	confidence: number;
	source_event_id: string | null;
	source_message_id: string | null;
	supersedes_fact_id: string | null;
	pinned: number;
	created_at: number;
	updated_at: number;
}

interface OpenLoopRow {
	id: string;
	conversation_id: string;
	loop_key: string;
	loop_type: string;
	title: string;
	description: string;
	status: string;
	priority: number;
	related_entity_ids_json: string;
	source_event_id: string | null;
	source_message_id: string | null;
	idle_turns: number;
	created_at: number;
	updated_at: number;
}

interface PatchRow {
	id: string;
	conversation_id: string;
	turn_id: string | null;
	status: MemoryPatchStatus;
	summary: string;
	raw_patch_json: string;
	validation_result_json: string;
	extractor_kind: string | null;
	extractor_model: string | null;
	extractor_confidence: number | null;
	extractor_diagnostics_json: string | null;
	created_at: number;
	committed_at: number | null;
}

interface IssueRow {
	id: string;
	conversation_id: string;
	patch_id: string | null;
	severity: 'info' | 'warning' | 'error';
	code: string;
	message: string;
	status: string;
	created_at: number;
	resolved_at: number | null;
}

interface ToolCallRow {
	id: string;
	conversation_id: string;
	turn_id: string | null;
	tool_name: string;
	arguments_json: string;
	result_summary: string;
	result_ids_json: string;
	created_at: number;
}

interface PatchItemRow {
	id: string;
	patch_id: string;
	conversation_id: string;
	item_type: string;
	item_id: string;
	action: string;
	review_status: string;
	reviewed_at: number | null;
	created_at: number;
}

interface GlobalMemoryRow {
	id: string;
	user_id: string;
	kind: string;
	memory_key: string;
	value_json: string;
	status: string;
	source_conversation_id: string | null;
	source_message_id: string | null;
	created_at: number;
	updated_at: number;
}

export interface MemorySnapshot {
	mode: MemoryMode;
	entities: MemoryEntity[];
	facts: MemoryFact[];
	openLoops: MemoryOpenLoop[];
	events: MemoryEvent[];
	patches: MemoryPatch[];
	issues: MemoryValidationIssue[];
	toolCalls: MemoryToolCall[];
	patchItems: MemoryPatchItem[];
	globalMemories?: GlobalMemory[];
}

export interface UpsertEntityInput {
	entityKey: string;
	entityType?: string;
	displayName?: string;
	summary?: string;
	metadata?: unknown;
	sourceMessageId?: string | null;
	turnId?: string | null;
}

export interface AddEventInput {
	turnId?: string | null;
	eventType: string;
	summary: string;
	payload?: unknown;
	visibility?: string;
	confidence?: number;
	sourceMessageId?: string | null;
	actorEntityId?: string | null;
	targetEntityId?: string | null;
}

export interface AddFactInput {
	entityId?: string | null;
	predicate: string;
	value: unknown;
	visibility?: string;
	confidence?: number;
	sourceEventId?: string | null;
	sourceMessageId?: string | null;
	supersedesFactId?: string | null;
	pinned?: boolean;
}

/**
 * Predicates that hold a single current value per entity. When a new fact for
 * one of these is committed, prior active facts with the same entity+predicate
 * are superseded instead of accumulating — this bounds memory growth at the
 * source for state-like facts (location, status, ...).
 */
const SINGLE_VALUED_PREDICATES = new Set(['location', 'status', 'state', 'place', 'position']);

function isSingleValuedPredicate(predicate: string): boolean {
	return SINGLE_VALUED_PREDICATES.has(predicate.toLowerCase());
}

export interface AddOpenLoopInput {
	loopType: string;
	title: string;
	description?: string;
	priority?: number;
	relatedEntityIds?: string[];
	sourceEventId?: string | null;
	sourceMessageId?: string | null;
}

export interface CreatePatchInput {
	turnId?: string | null;
	sourceMessageId?: string | null;
	status: MemoryPatchStatus;
	summary?: string;
	rawPatch?: unknown;
	validationResult?: unknown;
	extractorKind?: string;
	extractorModel?: string;
	extractorConfidence?: number;
	extractorDiagnostics?: unknown;
	committedAt?: number | null;
}

export function getMode(conversationId: string): MemoryMode {
	const row = getDb()
		.prepare('SELECT memory_mode FROM conversations WHERE id = ?')
		.get(conversationId) as { memory_mode: string | null } | undefined;
	return normalizeMemoryMode(row?.memory_mode);
}

export function listSnapshot(
	conversationId: string,
	opts: { userId?: string } = {}
): MemorySnapshot {
	return {
		mode: getMode(conversationId),
		entities: listEntities(conversationId, { limit: 200 }),
		facts: listFacts(conversationId, { limit: 300 }),
		openLoops: listOpenLoops(conversationId, { status: 'open', limit: 100 }),
		events: listEvents(conversationId, { limit: 100 }),
		patches: listPatches(conversationId, { limit: 50 }),
		issues: listIssues(conversationId, { limit: 100 }),
		toolCalls: listToolCalls(conversationId, { limit: 50 }),
		patchItems: listPatchItems(conversationId, { limit: 200 }),
		globalMemories: opts.userId ? listGlobalMemories(opts.userId, { limit: 100 }) : undefined
	};
}

export function upsertEntity(conversationId: string, input: UpsertEntityInput): MemoryEntity {
	const db = getDb();
	const now = Date.now();
	const existing = db
		.prepare('SELECT * FROM memory_entities WHERE conversation_id = ? AND entity_key = ?')
		.get(conversationId, input.entityKey) as EntityRow | undefined;
	if (existing) {
		db.prepare(
			`UPDATE memory_entities
			    SET entity_type = ?, display_name = ?, summary = ?, metadata_json = ?, updated_at = ?
			  WHERE id = ?`
		).run(
			input.entityType ?? existing.entity_type,
			input.displayName ?? existing.display_name,
			input.summary ?? existing.summary,
			safeJson(input.metadata ?? parseJson(existing.metadata_json, {})),
			now,
			existing.id
		);
		const updated = db
			.prepare('SELECT * FROM memory_entities WHERE id = ?')
			.get(existing.id) as EntityRow;
		indexItem(db, conversationId, 'entity', existing.id, entityIndexText(updated));
		appendSessionMemoryLog(db, conversationId, {
			eventKind: 'entity.update',
			itemType: 'entity',
			itemId: existing.id,
			sourceMessageId: input.sourceMessageId ?? null,
			turnId: input.turnId ?? null,
			payload: { item: rowToEntity(updated) }
		});
		return rowToEntity(updated);
	}
	const id = ulid();
	// On INSERT the caller is responsible for resolving entityType/displayName
	// (the engine commit path derives them from the entityKey for a brand-new
	// entity — see deriveEntityFromKey). The `?? ''` is only a type-level guard;
	// legitimate new entities always arrive with both fields populated.
	db.prepare(
		`INSERT INTO memory_entities(
		   id, conversation_id, entity_key, entity_type, display_name, summary, status,
		   metadata_json, created_at, updated_at
		 ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
	).run(
		id,
		conversationId,
		input.entityKey,
		input.entityType ?? '',
		input.displayName ?? '',
		input.summary ?? '',
		safeJson(input.metadata ?? {}),
		now,
		now
	);
	const row = db.prepare('SELECT * FROM memory_entities WHERE id = ?').get(id) as EntityRow;
	indexItem(db, conversationId, 'entity', id, entityIndexText(row));
	appendSessionMemoryLog(db, conversationId, {
		eventKind: 'entity.create',
		itemType: 'entity',
		itemId: id,
		sourceMessageId: input.sourceMessageId ?? null,
		turnId: input.turnId ?? null,
		payload: { item: rowToEntity(row) }
	});
	return rowToEntity(row);
}

export function getEntity(conversationId: string, entityKeyOrId: string): MemoryEntity | null {
	const row = getDb()
		.prepare(
			`SELECT * FROM memory_entities
			  WHERE conversation_id = ? AND (id = ? OR entity_key = ?)
			  LIMIT 1`
		)
		.get(conversationId, entityKeyOrId, entityKeyOrId) as EntityRow | undefined;
	return row ? rowToEntity(row) : null;
}

export function listEntities(
	conversationId: string,
	opts: { limit?: number; entityType?: string; status?: string } = {}
): MemoryEntity[] {
	const limit = opts.limit ?? 100;
	const status = opts.status ?? 'active';
	const rows = opts.entityType
		? (getDb()
				.prepare(
					`SELECT * FROM memory_entities
					  WHERE conversation_id = ? AND entity_type = ? AND status = ?
					  ORDER BY updated_at DESC LIMIT ?`
				)
				.all(conversationId, opts.entityType, status, limit) as EntityRow[])
		: (getDb()
				.prepare(
					`SELECT * FROM memory_entities
					  WHERE conversation_id = ? AND status = ?
					  ORDER BY updated_at DESC LIMIT ?`
				)
				.all(conversationId, status, limit) as EntityRow[]);
	return rows.map(rowToEntity);
}

export function addEvent(conversationId: string, input: AddEventInput): MemoryEvent {
	const id = ulid();
	const now = Date.now();
	getDb()
		.prepare(
			`INSERT INTO memory_events(
			   id, conversation_id, turn_id, event_type, occurred_at, actor_entity_id,
			   target_entity_id, summary, payload_json, visibility, confidence,
			   source_message_id, source_tool_call_id, created_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
		)
		.run(
			id,
			conversationId,
			input.turnId ?? null,
			input.eventType,
			now,
			input.actorEntityId ?? null,
			input.targetEntityId ?? null,
			input.summary,
			safeJson(input.payload ?? {}),
			input.visibility ?? 'session',
			input.confidence ?? 1,
			input.sourceMessageId ?? null,
			now
		);
	const row = getDb().prepare('SELECT * FROM memory_events WHERE id = ?').get(id) as EventRow;
	indexItem(getDb(), conversationId, 'event', id, eventIndexText(row));
	appendSessionMemoryLog(getDb(), conversationId, {
		eventKind: 'event.create',
		itemType: 'event',
		itemId: id,
		sourceMessageId: input.sourceMessageId ?? null,
		turnId: input.turnId ?? null,
		payload: { item: rowToEvent(row) }
	});
	return rowToEvent(row);
}

export function listEvents(
	conversationId: string,
	opts: { limit?: number; entityId?: string; eventType?: string } = {}
): MemoryEvent[] {
	const limit = opts.limit ?? 50;
	let rows: EventRow[];
	if (opts.entityId) {
		rows = getDb()
			.prepare(
				`SELECT * FROM memory_events
				  WHERE conversation_id = ? AND (actor_entity_id = ? OR target_entity_id = ?)
				  ORDER BY created_at DESC LIMIT ?`
			)
			.all(conversationId, opts.entityId, opts.entityId, limit) as EventRow[];
	} else if (opts.eventType) {
		rows = getDb()
			.prepare(
				`SELECT * FROM memory_events
				  WHERE conversation_id = ? AND event_type = ?
				  ORDER BY created_at DESC LIMIT ?`
			)
			.all(conversationId, opts.eventType, limit) as EventRow[];
	} else {
		rows = getDb()
			.prepare(
				`SELECT * FROM memory_events
				  WHERE conversation_id = ?
				  ORDER BY created_at DESC LIMIT ?`
			)
			.all(conversationId, limit) as EventRow[];
	}
	return rows.map(rowToEvent);
}

export function addFact(conversationId: string, input: AddFactInput): MemoryFact {
	const db = getDb();
	const tx = db.transaction(() => {
		const now = Date.now();
		const id = ulid();
		// Append the raw observation as a `fact.create` event + projection row.
		// Supersession and dedupe are NOT decided here; they are derived from the
		// event stream by consolidateFactGroup (below), which is replayed on every
		// projection rebuild. That keeps a rebuild correct "for free": rebuilding
		// from the surviving observations re-derives the active set.
		db.prepare(
			`INSERT INTO memory_facts(
			   id, conversation_id, entity_id, predicate, value_json, status, visibility,
			   confidence, source_event_id, source_message_id, supersedes_fact_id,
			   pinned, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			id,
			conversationId,
			input.entityId ?? null,
			input.predicate,
			safeJson(input.value),
			input.visibility ?? 'session',
			input.confidence ?? 1,
			input.sourceEventId ?? null,
			input.sourceMessageId ?? null,
			input.supersedesFactId ?? null,
			input.pinned ? 1 : 0,
			now,
			now
		);
		const row = db.prepare('SELECT * FROM memory_facts WHERE id = ?').get(id) as FactRow;
		indexItem(db, conversationId, 'fact', id, factIndexText(row));
		appendSessionMemoryLog(db, conversationId, {
			eventKind: 'fact.create',
			itemType: 'fact',
			itemId: id,
			sourceMessageId: input.sourceMessageId ?? null,
			payload: { item: rowToFact(row) }
		});
		consolidateFactGroup(db, conversationId, row.entity_id, row.predicate);
		return db.prepare('SELECT * FROM memory_facts WHERE id = ?').get(id) as FactRow;
	});
	return rowToFact(tx());
}

/**
 * Derive the active set for one (entity, predicate) group in the projection.
 * This is the single home of consolidation, called from every path that mutates
 * a fact (imperative writes, edits/deletes, and event-stream replay) so the same
 * rule is applied whether facts arrive live or are rebuilt from the log:
 *
 *   - single-valued predicates (location, status, ...): only the newest
 *     observation in the group stays active; older ones become `superseded`.
 *   - other predicates: the newest observation of each distinct value stays
 *     active; older identical observations become `superseded` (dedupe).
 *
 * Because it operates purely on the projected rows (never emitting events), a
 * projection rebuilt from a stream that omits some observations — e.g. after the
 * facts a patch created are deleted — re-derives the correct active set
 * without any reference counting or supersede bookkeeping.
 */
function consolidateFactGroup(
	db: Database.Database,
	conversationId: string,
	entityId: string | null,
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

	const activeIds = new Set<string>();
	if (isSingleValuedPredicate(predicate)) {
		activeIds.add(rows[rows.length - 1].id);
	} else {
		// Newest row wins per distinct value (later rows overwrite the map entry).
		const newestByValue = new Map<string, string>();
		for (const row of rows) newestByValue.set(row.value_json, row.id);
		for (const id of newestByValue.values()) activeIds.add(id);
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

export function listFacts(
	conversationId: string,
	opts: { limit?: number; entityId?: string; status?: string; predicate?: string } = {}
): MemoryFact[] {
	const limit = opts.limit ?? 100;
	const status = opts.status ?? 'active';
	const clauses = ['conversation_id = ?', 'status = ?'];
	const params: (string | number)[] = [conversationId, status];
	if (opts.entityId) {
		clauses.push('entity_id = ?');
		params.push(opts.entityId);
	}
	if (opts.predicate) {
		clauses.push('predicate = ?');
		params.push(opts.predicate);
	}
	params.push(limit);
	const rows = getDb()
		.prepare(
			`SELECT * FROM memory_facts
			  WHERE ${clauses.join(' AND ')}
			  ORDER BY updated_at DESC LIMIT ?`
		)
		.all(...params) as FactRow[];
	return rows.map(rowToFact);
}

/**
 * Count active facts per entity for a conversation. Powers the always-present
 * entity-key index in the turn packet (so the model knows how much is queryable
 * by name even when individual fact bodies are dropped from the packet).
 */
/**
 * Fetch a single fact by id (any status), or null if it doesn't exist in this
 * conversation. Used by the forget path to resolve a packet `[id=...]` handle to
 * a concrete fact and check its current status/kind before tombstoning it.
 */
export function getFact(conversationId: string, id: string): MemoryFact | null {
	if (!id) return null;
	const row = getDb()
		.prepare('SELECT * FROM memory_facts WHERE id = ? AND conversation_id = ?')
		.get(id, conversationId) as FactRow | undefined;
	return row ? rowToFact(row) : null;
}

export function entityFactCounts(conversationId: string): Map<string, number> {
	const rows = getDb()
		.prepare(
			`SELECT entity_id AS entityId, COUNT(*) AS count
			   FROM memory_facts
			  WHERE conversation_id = ? AND status = 'active' AND entity_id IS NOT NULL
			  GROUP BY entity_id`
		)
		.all(conversationId) as Array<{ entityId: string; count: number }>;
	const counts = new Map<string, number>();
	for (const row of rows) counts.set(row.entityId, row.count);
	return counts;
}

/**
 * Derive a stable, legible loop key from its title (e.g. "Find the attic key"
 * -> `loop.find_the_attic_key`). The result is namespaced like an entityKey so
 * the model treats it as the same kind of handle.
 */
function slugifyLoopKey(title: string): string {
	const base = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 60);
	return `loop.${base || 'thread'}`;
}

/**
 * Allocate a conversation-unique loop key, suffixing `_2`, `_3`, ... on
 * collision. Generated once at creation and persisted in the create event, so
 * replay restores it rather than regenerating (keeping event-sourcing faithful).
 */
function allocateLoopKey(db: Database.Database, conversationId: string, title: string): string {
	const base = slugifyLoopKey(title);
	const taken = db.prepare(
		'SELECT 1 FROM memory_open_loops WHERE conversation_id = ? AND loop_key = ?'
	);
	if (!taken.get(conversationId, base)) return base;
	let n = 2;
	while (taken.get(conversationId, `${base}_${n}`)) n++;
	return `${base}_${n}`;
}

/**
 * Resolve a model-supplied open-loop reference — which may be either the stable
 * `loop_key` or the raw ULID `id` — to the canonical loop id, or null if no such
 * loop exists in the conversation. Tries the id (primary key) first, then a
 * non-empty key, so both addressing forms work and id-based internal callers are
 * unaffected.
 */
export function resolveOpenLoopId(conversationId: string, ref: string): string | null {
	if (!ref) return null;
	const db = getDb();
	const byId = db
		.prepare('SELECT id FROM memory_open_loops WHERE id = ? AND conversation_id = ?')
		.get(ref, conversationId) as { id: string } | undefined;
	if (byId) return byId.id;
	const byKey = db
		.prepare(
			"SELECT id FROM memory_open_loops WHERE loop_key = ? AND conversation_id = ? AND loop_key != ''"
		)
		.get(ref, conversationId) as { id: string } | undefined;
	return byKey ? byKey.id : null;
}

export function addOpenLoop(conversationId: string, input: AddOpenLoopInput): MemoryOpenLoop {
	const id = ulid();
	const now = Date.now();
	const loopKey = allocateLoopKey(getDb(), conversationId, input.title);
	getDb()
		.prepare(
			`INSERT INTO memory_open_loops(
			   id, conversation_id, loop_key, loop_type, title, description, status, priority,
			   related_entity_ids_json, source_event_id, source_message_id, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`
		)
		.run(
			id,
			conversationId,
			loopKey,
			input.loopType,
			input.title,
			input.description ?? '',
			input.priority ?? 0,
			safeJson(input.relatedEntityIds ?? []),
			input.sourceEventId ?? null,
			input.sourceMessageId ?? null,
			now,
			now
		);
	const row = getDb()
		.prepare('SELECT * FROM memory_open_loops WHERE id = ?')
		.get(id) as OpenLoopRow;
	indexItem(getDb(), conversationId, 'open_loop', id, openLoopIndexText(row));
	appendSessionMemoryLog(getDb(), conversationId, {
		eventKind: 'open_loop.create',
		itemType: 'open_loop',
		itemId: id,
		sourceMessageId: input.sourceMessageId ?? null,
		payload: { item: rowToOpenLoop(row) }
	});
	return rowToOpenLoop(row);
}

export function getOpenLoop(conversationId: string, id: string): MemoryOpenLoop | null {
	const row = getDb()
		.prepare('SELECT * FROM memory_open_loops WHERE id = ? AND conversation_id = ?')
		.get(id, conversationId) as OpenLoopRow | undefined;
	return row ? rowToOpenLoop(row) : null;
}

export function listOpenLoops(
	conversationId: string,
	opts: { limit?: number; status?: string; loopType?: string } = {}
): MemoryOpenLoop[] {
	const limit = opts.limit ?? 50;
	const status = opts.status ?? 'open';
	if (status === 'all') {
		const rows = opts.loopType
			? (getDb()
					.prepare(
						`SELECT * FROM memory_open_loops
						  WHERE conversation_id = ? AND loop_type = ?
						  ORDER BY priority DESC, updated_at DESC LIMIT ?`
					)
					.all(conversationId, opts.loopType, limit) as OpenLoopRow[])
			: (getDb()
					.prepare(
						`SELECT * FROM memory_open_loops
						  WHERE conversation_id = ?
						  ORDER BY priority DESC, updated_at DESC LIMIT ?`
					)
					.all(conversationId, limit) as OpenLoopRow[]);
		return rows.map(rowToOpenLoop);
	}
	const rows = opts.loopType
		? (getDb()
				.prepare(
					`SELECT * FROM memory_open_loops
					  WHERE conversation_id = ? AND loop_type = ? AND status = ?
					  ORDER BY priority DESC, updated_at DESC LIMIT ?`
				)
				.all(conversationId, opts.loopType, status, limit) as OpenLoopRow[])
		: (getDb()
				.prepare(
					`SELECT * FROM memory_open_loops
					  WHERE conversation_id = ? AND status = ?
					  ORDER BY priority DESC, updated_at DESC LIMIT ?`
				)
				.all(conversationId, status, limit) as OpenLoopRow[]);
	return rows.map(rowToOpenLoop);
}

export function createPatch(conversationId: string, input: CreatePatchInput): MemoryPatch {
	const id = ulid();
	const now = Date.now();
	getDb()
		.prepare(
			`INSERT INTO memory_patches(
			   id, conversation_id, turn_id, status, summary, raw_patch_json,
			   validation_result_json, extractor_kind, extractor_model, extractor_confidence,
			   extractor_diagnostics_json, created_at, committed_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			id,
			conversationId,
			input.turnId ?? null,
			input.status,
			input.summary ?? '',
			safeJson(input.rawPatch ?? {}),
			safeJson(input.validationResult ?? {}),
			input.extractorKind ?? null,
			input.extractorModel ?? null,
			input.extractorConfidence ?? null,
			safeJson(input.extractorDiagnostics ?? []),
			now,
			input.committedAt ?? null
		);
	const row = getDb().prepare('SELECT * FROM memory_patches WHERE id = ?').get(id) as PatchRow;
	appendSessionMemoryLog(getDb(), conversationId, {
		eventKind: 'patch.create',
		itemType: 'patch',
		itemId: id,
		sourceMessageId: input.sourceMessageId ?? null,
		turnId: input.turnId ?? null,
		payload: { patch: rowToPatch(row) }
	});
	return rowToPatch(row);
}

export function listPatches(conversationId: string, opts: { limit?: number } = {}): MemoryPatch[] {
	const rows = getDb()
		.prepare(
			`SELECT * FROM memory_patches
			  WHERE conversation_id = ?
			  ORDER BY created_at DESC LIMIT ?`
		)
		.all(conversationId, opts.limit ?? 50) as PatchRow[];
	return rows.map(rowToPatch);
}

export function updatePatchStatus(
	conversationId: string,
	patchId: string,
	status: MemoryPatchStatus,
	validationResult?: unknown
): MemoryPatch | null {
	const now = Date.now();
	const result = getDb()
		.prepare(
			`UPDATE memory_patches
			    SET status = ?,
			        validation_result_json = CASE WHEN ? IS NULL THEN validation_result_json ELSE ? END,
			        committed_at = CASE WHEN ? IN ('committed', 'partially_committed') THEN COALESCE(committed_at, ?) ELSE committed_at END
			  WHERE id = ? AND conversation_id = ?`
		)
		.run(
			status,
			validationResult === undefined ? null : safeJson(validationResult),
			validationResult === undefined ? null : safeJson(validationResult),
			status,
			now,
			patchId,
			conversationId
		);
	if (result.changes === 0) return null;
	const row = getDb()
		.prepare('SELECT * FROM memory_patches WHERE id = ? AND conversation_id = ?')
		.get(patchId, conversationId) as PatchRow;
	appendSessionMemoryLog(getDb(), conversationId, {
		eventKind: 'patch.update',
		itemType: 'patch',
		itemId: patchId,
		payload: { patch: rowToPatch(row) }
	});
	return rowToPatch(row);
}

export function recordPatchItem(
	conversationId: string,
	input: { patchId: string; itemType: string; itemId: string; action: string }
): MemoryPatchItem {
	const id = ulid();
	const now = Date.now();
	getDb()
		.prepare(
			`INSERT INTO memory_patch_items(id, patch_id, conversation_id, item_type, item_id, action, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
		.run(id, input.patchId, conversationId, input.itemType, input.itemId, input.action, now);
	const row = getDb()
		.prepare('SELECT * FROM memory_patch_items WHERE id = ?')
		.get(id) as PatchItemRow;
	appendSessionMemoryLog(getDb(), conversationId, {
		eventKind: 'patch_item.create',
		itemType: 'patch_item',
		itemId: id,
		payload: { item: rowToPatchItem(row) }
	});
	return rowToPatchItem(row);
}

export function listPatchItems(
	conversationId: string,
	opts: { patchId?: string; limit?: number } = {}
): MemoryPatchItem[] {
	const rows = opts.patchId
		? (getDb()
				.prepare(
					`SELECT * FROM memory_patch_items
					  WHERE conversation_id = ? AND patch_id = ?
					  ORDER BY created_at DESC LIMIT ?`
				)
				.all(conversationId, opts.patchId, opts.limit ?? 200) as PatchItemRow[])
		: (getDb()
				.prepare(
					`SELECT * FROM memory_patch_items
					  WHERE conversation_id = ?
					  ORDER BY created_at DESC LIMIT ?`
				)
				.all(conversationId, opts.limit ?? 200) as PatchItemRow[]);
	return rows.map(rowToPatchItem);
}

export function reviewPatchItem(
	conversationId: string,
	patchItemId: string,
	decision: 'approve' | 'reject'
): { item: MemoryPatchItem | null; affected: boolean } {
	const current = getDb()
		.prepare('SELECT * FROM memory_patch_items WHERE id = ? AND conversation_id = ?')
		.get(patchItemId, conversationId) as PatchItemRow | undefined;
	if (!current) return { item: null, affected: false };
	let affected = false;
	const status = decision === 'approve' ? 'approved' : 'rejected';
	if (
		decision === 'reject' &&
		current.review_status !== 'rejected' &&
		current.action === 'create'
	) {
		affected = deleteItem(conversationId, current.item_type, current.item_id);
	}
	getDb()
		.prepare(
			`UPDATE memory_patch_items
			    SET review_status = ?, reviewed_at = ?
			  WHERE id = ? AND conversation_id = ?`
		)
		.run(status, Date.now(), patchItemId, conversationId);
	const item = getDb()
		.prepare('SELECT * FROM memory_patch_items WHERE id = ? AND conversation_id = ?')
		.get(patchItemId, conversationId) as PatchItemRow;
	appendSessionMemoryLog(getDb(), conversationId, {
		eventKind: 'patch_item.review',
		itemType: 'patch_item',
		itemId: patchItemId,
		payload: { item: rowToPatchItem(item), decision, affected }
	});
	return { item: rowToPatchItem(item), affected };
}

export function updateEntity(
	conversationId: string,
	id: string,
	patch: Partial<Pick<MemoryEntity, 'displayName' | 'summary' | 'status'>> & {
		entityType?: string;
		metadata?: unknown;
	}
): MemoryEntity | null {
	const current = getEntity(conversationId, id);
	if (!current) return null;
	const next = {
		entityType: patch.entityType ?? current.entityType,
		displayName: patch.displayName ?? current.displayName,
		summary: patch.summary ?? current.summary,
		status: patch.status ?? current.status,
		metadata: patch.metadata ?? current.metadata
	};
	getDb()
		.prepare(
			`UPDATE memory_entities
			    SET entity_type = ?, display_name = ?, summary = ?, status = ?, metadata_json = ?, updated_at = ?
			  WHERE id = ? AND conversation_id = ?`
		)
		.run(
			next.entityType,
			next.displayName,
			next.summary,
			next.status,
			safeJson(next.metadata),
			Date.now(),
			id,
			conversationId
		);
	const row = getDb()
		.prepare('SELECT * FROM memory_entities WHERE id = ? AND conversation_id = ?')
		.get(id, conversationId) as EntityRow;
	syncSessionIndex(getDb(), conversationId, 'entity', id, row.status, entityIndexText(row));
	appendSessionMemoryLog(getDb(), conversationId, {
		eventKind: row.status === 'deleted' ? 'entity.delete' : 'entity.update',
		itemType: 'entity',
		itemId: id,
		payload: { item: rowToEntity(row) }
	});
	return rowToEntity(row);
}

export interface MergeEntitiesResult {
	ok: boolean;
	error?: string;
	from?: MemoryEntity;
	into?: MemoryEntity;
	reassignedFacts: number;
	reassignedEvents: number;
}

/**
 * Fold a duplicate entity into a canonical one. Every fact and event that
 * pointed at `fromKeyOrId` is re-pointed at `intoKeyOrId` and the duplicate is
 * tombstoned. All mutations go through the append-only session memory log
 * (`fact.update` / `event.update` / `entity.delete` events carrying the new
 * snapshot), so projection rebuilds and forks reconstruct the merged
 * state exactly. After reassigning facts, both the source and destination
 * (entity, predicate) groups are re-consolidated so single-valued predicates
 * keep one active value and duplicate observations collapse.
 *
 * This is the cleanup path for the extractor's most common mistake: minting two
 * entities for the same referent (e.g. `character.firstname` and
 * `character.firstname_lastname`). Whether two keys are the *same* referent is a
 * semantic call left to the caller; this function only performs the merge it is
 * told to.
 */
export function mergeEntities(
	conversationId: string,
	opts: { fromKeyOrId: string; intoKeyOrId: string }
): MergeEntitiesResult {
	const db = getDb();
	const tx = db.transaction((): MergeEntitiesResult => {
		const from = getEntity(conversationId, opts.fromKeyOrId);
		const into = getEntity(conversationId, opts.intoKeyOrId);
		if (!from)
			return {
				ok: false,
				error: `Unknown source entity: ${opts.fromKeyOrId}`,
				reassignedFacts: 0,
				reassignedEvents: 0
			};
		if (!into)
			return {
				ok: false,
				error: `Unknown target entity: ${opts.intoKeyOrId}`,
				reassignedFacts: 0,
				reassignedEvents: 0
			};
		if (from.id === into.id)
			return {
				ok: false,
				error: 'Source and target refer to the same entity; nothing to merge.',
				reassignedFacts: 0,
				reassignedEvents: 0
			};
		// Folding into a retired entity would silently bury the source's facts on a
		// tombstoned referent (hidden from active views), so reject it. Merging
		// *from* a deleted duplicate is fine — that is exactly the cleanup case.
		if (into.status === 'deleted')
			return {
				ok: false,
				error: `Target entity is deleted; pick a live canonical entity: ${opts.intoKeyOrId}`,
				reassignedFacts: 0,
				reassignedEvents: 0
			};

		const now = Date.now();
		// Predicates whose groups must be re-consolidated once facts move across.
		const touchedPredicates = new Set<string>();
		const factRows = db
			.prepare(
				`SELECT * FROM memory_facts
				  WHERE conversation_id = ? AND entity_id = ? AND status != 'deleted'`
			)
			.all(conversationId, from.id) as FactRow[];
		for (const factRow of factRows) {
			db.prepare(
				'UPDATE memory_facts SET entity_id = ?, updated_at = ? WHERE id = ? AND conversation_id = ?'
			).run(into.id, now, factRow.id, conversationId);
			const updated = db
				.prepare('SELECT * FROM memory_facts WHERE id = ?')
				.get(factRow.id) as FactRow;
			syncSessionIndex(
				db,
				conversationId,
				'fact',
				updated.id,
				updated.status,
				factIndexText(updated)
			);
			appendSessionMemoryLog(db, conversationId, {
				eventKind: 'fact.update',
				itemType: 'fact',
				itemId: updated.id,
				payload: { item: rowToFact(updated) }
			});
			touchedPredicates.add(updated.predicate);
		}
		// Re-derive the active set for both the vacated and the receiving groups:
		// the destination may now hold duplicate observations of a single-valued
		// predicate, and the source group is left empty.
		for (const predicate of touchedPredicates) {
			consolidateFactGroup(db, conversationId, into.id, predicate);
			consolidateFactGroup(db, conversationId, from.id, predicate);
		}

		const eventRows = db
			.prepare(
				`SELECT * FROM memory_events
				  WHERE conversation_id = ? AND (actor_entity_id = ? OR target_entity_id = ?)`
			)
			.all(conversationId, from.id, from.id) as EventRow[];
		for (const eventRow of eventRows) {
			const nextActor = eventRow.actor_entity_id === from.id ? into.id : eventRow.actor_entity_id;
			const nextTarget =
				eventRow.target_entity_id === from.id ? into.id : eventRow.target_entity_id;
			db.prepare(
				'UPDATE memory_events SET actor_entity_id = ?, target_entity_id = ? WHERE id = ? AND conversation_id = ?'
			).run(nextActor, nextTarget, eventRow.id, conversationId);
			const updated = db
				.prepare('SELECT * FROM memory_events WHERE id = ?')
				.get(eventRow.id) as EventRow;
			indexItem(db, conversationId, 'event', updated.id, eventIndexText(updated));
			appendSessionMemoryLog(db, conversationId, {
				eventKind: 'event.update',
				itemType: 'event',
				itemId: updated.id,
				payload: { item: rowToEvent(updated) }
			});
		}

		// Carry forward any open loops that referenced only the duplicate so the
		// canonical entity inherits them.
		const loopRows = db
			.prepare(`SELECT * FROM memory_open_loops WHERE conversation_id = ? AND status != 'deleted'`)
			.all(conversationId) as OpenLoopRow[];
		for (const loopRow of loopRows) {
			const related = parseJson(loopRow.related_entity_ids_json, []) as string[];
			if (!related.includes(from.id)) continue;
			const next = related.map((id) => (id === from.id ? into.id : id));
			const deduped = [...new Set(next)];
			updateOpenLoop(conversationId, loopRow.id, { relatedEntityIds: deduped });
		}

		const tombstoned = updateEntity(conversationId, from.id, { status: 'deleted' });
		addEvent(conversationId, {
			eventType: 'memory_entities_merged',
			summary: `Merged ${from.entityKey} into ${into.entityKey}.`,
			payload: {
				fromEntityId: from.id,
				fromEntityKey: from.entityKey,
				intoEntityId: into.id,
				intoEntityKey: into.entityKey,
				reassignedFacts: factRows.length,
				reassignedEvents: eventRows.length
			},
			confidence: 1
		});

		return {
			ok: true,
			from: tombstoned ?? from,
			into,
			reassignedFacts: factRows.length,
			reassignedEvents: eventRows.length
		};
	});
	return tx();
}

export function updateFact(
	conversationId: string,
	id: string,
	patch: Partial<Pick<MemoryFact, 'predicate' | 'value' | 'status' | 'visibility' | 'confidence'>>
): MemoryFact | null {
	const db = getDb();
	const tx = db.transaction(() => {
		const current = db
			.prepare('SELECT * FROM memory_facts WHERE id = ? AND conversation_id = ?')
			.get(id, conversationId) as FactRow | undefined;
		if (!current) return null;
		db.prepare(
			`UPDATE memory_facts
			    SET predicate = ?, value_json = ?, status = ?, visibility = ?, confidence = ?, updated_at = ?
			  WHERE id = ? AND conversation_id = ?`
		).run(
			patch.predicate ?? current.predicate,
			patch.value === undefined ? current.value_json : safeJson(patch.value),
			patch.status ?? current.status,
			patch.visibility ?? current.visibility,
			patch.confidence ?? current.confidence,
			Date.now(),
			id,
			conversationId
		);
		const row = db
			.prepare('SELECT * FROM memory_facts WHERE id = ? AND conversation_id = ?')
			.get(id, conversationId) as FactRow;
		syncSessionIndex(db, conversationId, 'fact', id, row.status, factIndexText(row));
		appendSessionMemoryLog(db, conversationId, {
			eventKind:
				row.status === 'deleted'
					? 'fact.delete'
					: row.status === 'superseded'
						? 'fact.supersede'
						: 'fact.update',
			itemType: 'fact',
			itemId: id,
			payload: { item: rowToFact(row) }
		});
		// Re-derive the active set: deleting/editing a fact can promote a previously
		// superseded sibling (e.g. dropping the observation that overrode it).
		consolidateFactGroup(db, conversationId, row.entity_id, row.predicate);
		return rowToFact(db.prepare('SELECT * FROM memory_facts WHERE id = ?').get(id) as FactRow);
	});
	return tx();
}

export function updateOpenLoop(
	conversationId: string,
	id: string,
	patch: Partial<
		Pick<
			MemoryOpenLoop,
			'loopType' | 'title' | 'description' | 'status' | 'priority' | 'relatedEntityIds'
		>
	>
): MemoryOpenLoop | null {
	const current = getDb()
		.prepare('SELECT * FROM memory_open_loops WHERE id = ? AND conversation_id = ?')
		.get(id, conversationId) as OpenLoopRow | undefined;
	if (!current) return null;
	getDb()
		.prepare(
			`UPDATE memory_open_loops
			    SET loop_type = ?, title = ?, description = ?, status = ?, priority = ?,
			        related_entity_ids_json = ?, updated_at = ?
			  WHERE id = ? AND conversation_id = ?`
		)
		.run(
			patch.loopType ?? current.loop_type,
			patch.title ?? current.title,
			patch.description ?? current.description,
			patch.status ?? current.status,
			patch.priority ?? current.priority,
			patch.relatedEntityIds === undefined
				? current.related_entity_ids_json
				: safeJson(patch.relatedEntityIds),
			Date.now(),
			id,
			conversationId
		);
	const row = getDb()
		.prepare('SELECT * FROM memory_open_loops WHERE id = ? AND conversation_id = ?')
		.get(id, conversationId) as OpenLoopRow;
	syncSessionIndex(getDb(), conversationId, 'open_loop', id, row.status, openLoopIndexText(row));
	appendSessionMemoryLog(getDb(), conversationId, {
		eventKind: row.status === 'deleted' ? 'open_loop.delete' : 'open_loop.update',
		itemType: 'open_loop',
		itemId: id,
		payload: { item: rowToOpenLoop(row) }
	});
	return rowToOpenLoop(row);
}

/**
 * Record one open-loop liveness ("touch-to-keep") pass as a first-class memory
 * event, then apply it to the live projection. `presentedLoopIds` are the open
 * loops the extractor was shown this pass; `keptLoopIds` are the subset it
 * reaffirmed. A presented loop that is not kept accrues an idle turn, and once
 * it has been ignored for `baseThreshold + max(0, priority)` consecutive passes
 * it is auto-dropped.
 *
 * Liveness is fully event-sourced: the decay/drop is *derived* by replaying the
 * liveness events during a projection rebuild (see
 * {@link applyOpenLoopLivenessProjection}), so fork/rewind reconstruct idle
 * counts and auto-drops faithfully instead of losing them. The decay threshold
 * is captured in the event payload so a later config change never rewrites
 * historical decay. Returns the ids dropped by this pass.
 */
export function recordOpenLoopLiveness(
	conversationId: string,
	input: {
		presentedLoopIds: string[];
		keptLoopIds?: string[];
		baseThreshold: number;
		sourceMessageId?: string | null;
		turnId?: string | null;
	}
): { dropped: string[] } {
	const presented = [...new Set(input.presentedLoopIds)].filter(Boolean);
	if (presented.length === 0 || !(input.baseThreshold > 0)) return { dropped: [] };
	const kept = [...new Set(input.keptLoopIds ?? [])].filter(Boolean);
	const payload = { presented, kept, baseThreshold: input.baseThreshold };
	const db = getDb();
	let dropped: string[] = [];
	const tx = db.transaction(() => {
		// Mutate the live projection directly (mirroring addOpenLoop et al.,
		// which upsert then log), then append the event so a later rebuild
		// re-derives the same result.
		dropped = applyOpenLoopLivenessProjection(db, conversationId, payload);
		appendSessionMemoryLog(db, conversationId, {
			eventKind: 'open_loop.liveness',
			itemType: 'open_loop_liveness',
			itemId: ulid(),
			sourceMessageId: input.sourceMessageId ?? null,
			turnId: input.turnId ?? null,
			payload
		});
	});
	tx();
	return { dropped };
}

interface OpenLoopLivenessPayload {
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
function applyOpenLoopLivenessProjection(
	db: Database.Database,
	conversationId: string,
	payload: OpenLoopLivenessPayload
): string[] {
	const presented = Array.isArray(payload.presented) ? (payload.presented as string[]) : [];
	const baseThreshold = typeof payload.baseThreshold === 'number' ? payload.baseThreshold : 0;
	if (presented.length === 0 || baseThreshold <= 0) return [];
	const kept = new Set(Array.isArray(payload.kept) ? (payload.kept as string[]) : []);
	const dropped: string[] = [];
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

export function deleteItem(conversationId: string, kind: string, id: string): boolean {
	const normalized = normalizeKind(kind);
	if (!normalized) return false;
	if (normalized === 'entity')
		return updateEntity(conversationId, id, { status: 'deleted' }) !== null;
	if (normalized === 'fact') return updateFact(conversationId, id, { status: 'deleted' }) !== null;
	if (normalized === 'open_loop')
		return updateOpenLoop(conversationId, id, { status: 'deleted' }) !== null;
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
export function revertCommittedPatch(conversationId: string, patchId: string): void {
	const items = listPatchItems(conversationId, { patchId, limit: 1000 });
	const db = getDb();
	// Apply every item AND rebuild the projection inside one transaction so a
	// crash mid-loop can't leave a half-reverted state (some facts restored,
	// others deleted, projection stale). The helpers below open their own
	// db.transaction(...); better-sqlite3 nests these as savepoints, so the
	// whole revert commits or rolls back atomically.
	const tx = db.transaction(() => {
		for (const item of items) {
			if (item.action === 'create') {
				deleteItem(conversationId, item.itemType, item.itemId);
			} else if (item.action === 'resolve' && item.itemType === 'open_loop') {
				updateOpenLoop(conversationId, item.itemId, { status: 'open' });
			} else if (item.action === 'forget' && item.itemType === 'fact') {
				updateFact(conversationId, item.itemId, { status: 'active' });
			}
		}
		rebuildSessionMemoryProjection(conversationId);
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
	conversationId: string,
	messageId: string
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
	conversationId: string,
	assistantMessageId: string,
	read: () => T
): T {
	const db = getDb();
	const savepoint = `memory_turn_start_view_${turnStartViewSavepointSeq++}`;
	db.exec(`SAVEPOINT ${savepoint}`);
	try {
		const branchPoint = headBeforeMessage(db, conversationId, assistantMessageId);
		rebuildSessionMemoryProjectionInTransaction(db, conversationId, branchPoint);
		return read();
	} finally {
		// Discard the transient re-projection (and its head move); the materialized
		// packet `read` returned is plain JS objects, so it survives the rollback.
		db.exec(`ROLLBACK TO ${savepoint}`);
		db.exec(`RELEASE ${savepoint}`);
	}
}

export function upsertGlobalMemory(
	userId: string,
	input: {
		kind: string;
		memoryKey: string;
		value: unknown;
		sourceConversationId?: string | null;
		sourceMessageId?: string | null;
	}
): GlobalMemory {
	const db = getDb();
	const now = Date.now();
	const existing = db
		.prepare(
			`SELECT * FROM global_memories
			  WHERE user_id = ? AND kind = ? AND memory_key = ?`
		)
		.get(userId, input.kind, input.memoryKey) as GlobalMemoryRow | undefined;
	if (existing) {
		db.prepare(
			`UPDATE global_memories
			    SET value_json = ?, status = 'active', source_conversation_id = ?,
			        source_message_id = ?, updated_at = ?
			  WHERE id = ?`
		).run(
			safeJson(input.value),
			input.sourceConversationId ?? existing.source_conversation_id,
			input.sourceMessageId ?? existing.source_message_id,
			now,
			existing.id
		);
		const updated = db
			.prepare('SELECT * FROM global_memories WHERE id = ?')
			.get(existing.id) as GlobalMemoryRow;
		indexGlobalMemory(db, userId, updated.id, globalMemoryIndexText(updated));
		return rowToGlobalMemory(updated);
	}
	const id = ulid();
	db.prepare(
		`INSERT INTO global_memories(
		   id, user_id, kind, memory_key, value_json, status, source_conversation_id,
		   source_message_id, created_at, updated_at
		 ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
	).run(
		id,
		userId,
		input.kind,
		input.memoryKey,
		safeJson(input.value),
		input.sourceConversationId ?? null,
		input.sourceMessageId ?? null,
		now,
		now
	);
	const row = db.prepare('SELECT * FROM global_memories WHERE id = ?').get(id) as GlobalMemoryRow;
	indexGlobalMemory(db, userId, id, globalMemoryIndexText(row));
	return rowToGlobalMemory(row);
}

export type UpdateGlobalMemoryResult =
	| { status: 'updated'; memory: GlobalMemory }
	| { status: 'not_found' }
	| { status: 'conflict' };

export function updateGlobalMemory(
	userId: string,
	id: string,
	input: {
		kind: string;
		memoryKey: string;
		value: unknown;
		sourceConversationId?: string | null;
		sourceMessageId?: string | null;
	}
): UpdateGlobalMemoryResult {
	const db = getDb();
	const current = db
		.prepare('SELECT * FROM global_memories WHERE id = ? AND user_id = ?')
		.get(id, userId) as GlobalMemoryRow | undefined;
	if (!current) return { status: 'not_found' };
	const conflict = db
		.prepare(
			`SELECT id FROM global_memories
			  WHERE user_id = ? AND kind = ? AND memory_key = ? AND id != ?`
		)
		.get(userId, input.kind, input.memoryKey, id) as { id: string } | undefined;
	if (conflict) return { status: 'conflict' };
	const now = Date.now();
	db.prepare(
		`UPDATE global_memories
		    SET kind = ?, memory_key = ?, value_json = ?, status = 'active',
		        source_conversation_id = ?, source_message_id = ?, updated_at = ?
		  WHERE id = ? AND user_id = ?`
	).run(
		input.kind,
		input.memoryKey,
		safeJson(input.value),
		input.sourceConversationId ?? current.source_conversation_id,
		input.sourceMessageId ?? current.source_message_id,
		now,
		id,
		userId
	);
	const updated = db
		.prepare('SELECT * FROM global_memories WHERE id = ? AND user_id = ?')
		.get(id, userId) as GlobalMemoryRow;
	indexGlobalMemory(db, userId, updated.id, globalMemoryIndexText(updated));
	return { status: 'updated', memory: rowToGlobalMemory(updated) };
}

export function listGlobalMemories(
	userId: string,
	opts: { kind?: string; status?: string; limit?: number } = {}
): GlobalMemory[] {
	const status = opts.status ?? 'active';
	const rows = opts.kind
		? (getDb()
				.prepare(
					`SELECT * FROM global_memories
					  WHERE user_id = ? AND kind = ? AND status = ?
					  ORDER BY updated_at DESC LIMIT ?`
				)
				.all(userId, opts.kind, status, opts.limit ?? 100) as GlobalMemoryRow[])
		: (getDb()
				.prepare(
					`SELECT * FROM global_memories
					  WHERE user_id = ? AND status = ?
					  ORDER BY updated_at DESC LIMIT ?`
				)
				.all(userId, status, opts.limit ?? 100) as GlobalMemoryRow[]);
	return rows.map(rowToGlobalMemory);
}

export function searchGlobalMemories(
	userId: string,
	opts: { query: string; limit?: number }
): Array<{ itemId: string; text: string }> {
	const query = opts.query.trim();
	if (!query) return [];
	const rows = getDb()
		.prepare(
			`SELECT item_id, text
			   FROM global_memory_search_index
			  WHERE user_id = ?
			    AND global_memory_search_index MATCH ?
			  ORDER BY rank
			  LIMIT ?`
		)
		.all(userId, ftsQuery(query), opts.limit ?? 20) as { item_id: string; text: string }[];
	return rows.map((row) => ({ itemId: row.item_id, text: row.text }));
}

export function deleteGlobalMemory(userId: string, id: string): boolean {
	const db = getDb();
	const result = db
		.prepare(
			`UPDATE global_memories
			    SET status = 'deleted', updated_at = ?
			  WHERE id = ? AND user_id = ?`
		)
		.run(Date.now(), id, userId);
	if (result.changes > 0) {
		deleteGlobalIndex(db, userId, id);
	}
	return result.changes > 0;
}

export function addIssue(
	conversationId: string,
	input: {
		patchId?: string | null;
		severity: 'info' | 'warning' | 'error';
		code: string;
		message: string;
	}
): MemoryValidationIssue {
	const id = ulid();
	const now = Date.now();
	getDb()
		.prepare(
			`INSERT INTO memory_validation_issues(
			   id, conversation_id, patch_id, severity, code, message, status, created_at, resolved_at
			 ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, NULL)`
		)
		.run(id, conversationId, input.patchId ?? null, input.severity, input.code, input.message, now);
	const row = getDb()
		.prepare('SELECT * FROM memory_validation_issues WHERE id = ?')
		.get(id) as IssueRow;
	appendSessionMemoryLog(getDb(), conversationId, {
		eventKind: 'issue.create',
		itemType: 'issue',
		itemId: id,
		payload: { issue: rowToIssue(row) }
	});
	return rowToIssue(row);
}

export function listIssues(
	conversationId: string,
	opts: { limit?: number; status?: string } = {}
): MemoryValidationIssue[] {
	const rows = getDb()
		.prepare(
			`SELECT * FROM memory_validation_issues
			  WHERE conversation_id = ? AND status = ?
			  ORDER BY created_at DESC LIMIT ?`
		)
		.all(conversationId, opts.status ?? 'open', opts.limit ?? 50) as IssueRow[];
	return rows.map(rowToIssue);
}

export function recordToolCall(
	conversationId: string,
	input: {
		turnId?: string | null;
		toolName: string;
		arguments: unknown;
		resultSummary: string;
		resultIds?: string[];
	}
): MemoryToolCall {
	const id = ulid();
	const now = Date.now();
	getDb()
		.prepare(
			`INSERT INTO memory_tool_calls(
			   id, conversation_id, turn_id, tool_name, arguments_json, result_summary,
			   result_ids_json, created_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			id,
			conversationId,
			input.turnId ?? null,
			input.toolName,
			safeJson(input.arguments),
			input.resultSummary,
			safeJson(input.resultIds ?? []),
			now
		);
	const row = getDb()
		.prepare('SELECT * FROM memory_tool_calls WHERE id = ?')
		.get(id) as ToolCallRow;
	appendSessionMemoryLog(getDb(), conversationId, {
		eventKind: 'tool_call.create',
		itemType: 'tool_call',
		itemId: id,
		turnId: input.turnId ?? null,
		payload: { toolCall: rowToToolCall(row) }
	});
	return rowToToolCall(row);
}

export function listToolCalls(
	conversationId: string,
	opts: { limit?: number } = {}
): MemoryToolCall[] {
	const rows = getDb()
		.prepare(
			`SELECT * FROM memory_tool_calls
			  WHERE conversation_id = ?
			  ORDER BY created_at DESC LIMIT ?`
		)
		.all(conversationId, opts.limit ?? 50) as ToolCallRow[];
	return rows.map(rowToToolCall);
}

export function search(
	conversationId: string,
	opts: { query: string; types?: string[]; limit?: number }
): Array<{ itemType: string; itemId: string; text: string; score?: number; sources?: string[] }> {
	const query = opts.query.trim();
	if (!query) return [];
	const limit = opts.limit ?? 20;
	const types = opts.types ?? [];
	// Push the type filter into SQL so LIMIT applies after filtering, avoiding
	// starvation when the top-ranked FTS hits are all of an unwanted type.
	const typeFilter =
		types.length > 0 ? `AND item_type IN (${types.map(() => '?').join(', ')})` : '';
	const rows = getDb()
		.prepare(
			`SELECT item_type, item_id, text
			   FROM memory_search_index
			  WHERE conversation_id = ?
			    AND memory_search_index MATCH ?
			    ${typeFilter}
			  ORDER BY rank
			  LIMIT ?`
		)
		.all(conversationId, ftsQuery(query), ...types, limit) as {
		item_type: string;
		item_id: string;
		text: string;
	}[];
	return rows.map((row, index) => ({
		itemType: row.item_type,
		itemId: row.item_id,
		text: row.text,
		score: limit - index,
		sources: ['fts']
	}));
}

export function wipe(conversationId: string): void {
	const db = getDb();
	const tx = db.transaction(() => {
		clearSessionMemoryProjection(db, conversationId);
		db.prepare('DELETE FROM memory_event_log WHERE conversation_id = ?').run(conversationId);
		db.prepare('DELETE FROM memory_refs WHERE conversation_id = ?').run(conversationId);
		db.prepare('DELETE FROM memory_heads WHERE conversation_id = ?').run(conversationId);
		db.prepare('DELETE FROM memory_message_heads WHERE conversation_id = ?').run(conversationId);
	});
	tx();
}

export function replaySessionMemoryLogForFork(
	sourceConversationId: string,
	targetConversationId: string,
	opts: { messageIdMap: Map<string, string>; createdBefore?: number }
): { entities: number; events: number; facts: number; openLoops: number } {
	const db = getDb();
	const included = new Set<string>();
	const isIncluded = (type: string, id: string) => included.has(`${type}:${id}`);
	const markIncluded = (type: string, id: string) => included.add(`${type}:${id}`);
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
	conversationId: string,
	opts: { messageIds: Set<string>; createdBefore?: number }
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
			.all(conversationId) as { message_id: string }[];
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

function countSessionProjectionRows(
	db: Database.Database,
	table: string,
	conversationId: string,
	status: string | null
): number {
	// `table` is an internal constant, never user input.
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

function getCurrentMemoryHead(db: Database.Database, conversationId: string): string | null {
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

function getProjectionMemoryHead(db: Database.Database, conversationId: string): string | null {
	const row = db
		.prepare('SELECT projection_event_id FROM memory_heads WHERE conversation_id = ?')
		.get(conversationId) as { projection_event_id: string | null } | undefined;
	return row?.projection_event_id ?? null;
}

function getLatestMessageId(db: Database.Database, conversationId: string): string | null {
	const row = db
		.prepare(
			`SELECT id
			   FROM messages
			  WHERE conversation_id = ?
			  ORDER BY created_at DESC, id DESC
			  LIMIT 1`
		)
		.get(conversationId) as { id: string } | undefined;
	return row?.id ?? null;
}

function getAppendParentMemoryHead(
	db: Database.Database,
	conversationId: string,
	sourceMessageId: string | null | undefined
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

function setProjectionMemoryHead(
	db: Database.Database,
	conversationId: string,
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
	conversationId: string,
	kind: MemoryRefKind,
	sourceKey: string,
	targetEventId: string
): string | null {
	const prev = db
		.prepare('SELECT target_event_id FROM memory_refs WHERE ref_kind = ? AND source_key = ?')
		.get(kind, sourceKey) as { target_event_id: string } | undefined;
	db.prepare(
		`INSERT INTO memory_refs(conversation_id, ref_kind, source_key, target_event_id, created_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(ref_kind, source_key) DO UPDATE SET
		   conversation_id = excluded.conversation_id,
		   target_event_id = excluded.target_event_id,
		   created_at = excluded.created_at`
	).run(conversationId, kind, sourceKey, targetEventId, Date.now());
	return prev && prev.target_event_id !== targetEventId ? prev.target_event_id : null;
}

// Remove an incoming reference. Returns the event id it pointed at (if any) so
// the caller can GC it.
function dropMemoryRef(
	db: Database.Database,
	kind: MemoryRefKind,
	sourceKey: string
): string | null {
	const prev = db
		.prepare('SELECT target_event_id FROM memory_refs WHERE ref_kind = ? AND source_key = ?')
		.get(kind, sourceKey) as { target_event_id: string } | undefined;
	db.prepare('DELETE FROM memory_refs WHERE ref_kind = ? AND source_key = ?').run(kind, sourceKey);
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
function gcMemoryEventChain(
	db: Database.Database,
	conversationId: string,
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
	conversationId: string,
	messageId: string,
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
	const orphaned = setMemoryRef(db, conversationId, 'message_head', messageId, headEventId);
	if (orphaned) gcMemoryEventChain(db, conversationId, orphaned);
}

// Drop the memory head for a message that is being removed (inline edit /
// rerun truncation), then GC whatever its reference was pinning.
function dropMemoryMessageHead(
	db: Database.Database,
	conversationId: string,
	messageId: string
): void {
	db.prepare('DELETE FROM memory_message_heads WHERE conversation_id = ? AND message_id = ?').run(
		conversationId,
		messageId
	);
	const orphaned = dropMemoryRef(db, 'message_head', messageId);
	if (orphaned) gcMemoryEventChain(db, conversationId, orphaned);
}

function headForMessagePrefix(
	db: Database.Database,
	conversationId: string,
	messageIds: Iterable<string>,
	opts: { createdBefore?: number } = {}
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

function chainRowsForHead(
	db: Database.Database,
	conversationId: string,
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

function appendSessionMemoryLog(
	db: Database.Database,
	conversationId: string,
	input: {
		eventKind: string;
		itemType: SessionMemoryLogItemType;
		itemId: string;
		sourceMessageId?: string | null;
		turnId?: string | null;
		payload: unknown;
		createdAt?: number;
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
	conversationId: string,
	messageId: string
): boolean {
	const row = db
		.prepare('SELECT 1 AS ok FROM messages WHERE conversation_id = ? AND id = ?')
		.get(conversationId, messageId) as { ok: number } | undefined;
	return row !== undefined;
}

function clearSessionMemoryProjection(db: Database.Database, conversationId: string): void {
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

export function rebuildSessionMemoryProjection(conversationId: string): void {
	const db = getDb();
	const tx = db.transaction(() => rebuildSessionMemoryProjectionInTransaction(db, conversationId));
	tx();
}

function rebuildSessionMemoryProjectionInTransaction(
	db: Database.Database,
	conversationId: string,
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
	const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
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
			consolidateFactGroup(db, item.conversationId, item.entityId, item.predicate);
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

function rebuildSessionMemoryIndexes(db: Database.Database, conversationId: string): void {
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
		item.id,
		item.conversationId,
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
		item.conversationId,
		item.turnId,
		item.eventType,
		item.occurredAt,
		item.actorEntityId,
		item.targetEntityId,
		item.summary,
		safeJson(item.payload ?? {}),
		item.visibility,
		item.confidence,
		item.sourceMessageId,
		item.sourceToolCallId,
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
		item.id,
		item.conversationId,
		item.entityId,
		item.predicate,
		safeJson(item.value),
		item.status,
		item.visibility,
		item.confidence,
		item.sourceEventId,
		item.sourceMessageId,
		item.supersedesFactId,
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
		item.conversationId,
		item.loopKey ?? '',
		item.loopType,
		item.title,
		item.description,
		item.status,
		item.priority,
		safeJson(item.relatedEntityIds ?? []),
		item.sourceEventId,
		item.sourceMessageId,
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
		patch.conversationId,
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
		item.id,
		item.patchId,
		item.conversationId,
		item.itemType,
		item.itemId,
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
		issue.conversationId,
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
		toolCall.conversationId,
		toolCall.turnId,
		toolCall.toolName,
		safeJson(toolCall.arguments ?? {}),
		toolCall.resultSummary,
		safeJson(toolCall.resultIds ?? []),
		toolCall.createdAt
	);
}

function payloadObject(payload: unknown): Record<string, unknown> {
	return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
}

function createForkMemoryRemapper(
	targetConversationId: string,
	messageIdMap: Map<string, string>,
	isCopied: (type: string, id: string) => boolean
): (itemType: SessionMemoryLogItemType, payload: unknown) => unknown {
	const idMaps = new Map<string, Map<string, string>>();
	// Mint (or reuse) the fork-local id for an item that IS being copied. Used
	// for each row's own primary id.
	const mintId = (type: string, id: string | null | undefined): string | null => {
		if (!id) return null;
		let typeMap = idMaps.get(type);
		if (!typeMap) {
			typeMap = new Map();
			idMaps.set(type, typeMap);
		}
		let next = typeMap.get(id);
		if (!next) {
			next = ulid();
			typeMap.set(id, next);
		}
		return next;
	};
	// Resolve a reference to another item. Returns the fork-local id only when
	// the referenced item was itself copied; otherwise null, so links to rows
	// left behind by the fork never dangle at a non-existent id.
	const refId = (type: string, id: string | null | undefined): string | null =>
		id && isCopied(type, id) ? mintId(type, id) : null;
	const mapMessage = (id: string | null | undefined): string | null =>
		id ? (messageIdMap.get(id) ?? null) : null;
	const remapItem = (itemType: SessionMemoryLogItemType, value: unknown): unknown => {
		if (!value || typeof value !== 'object') return value;
		if (itemType === 'entity') {
			const item = value as MemoryEntity;
			return { ...item, id: mintId('entity', item.id), conversationId: targetConversationId };
		}
		if (itemType === 'event') {
			const item = value as MemoryEvent;
			return {
				...item,
				id: mintId('event', item.id),
				conversationId: targetConversationId,
				turnId: null,
				actorEntityId: refId('entity', item.actorEntityId),
				targetEntityId: refId('entity', item.targetEntityId),
				sourceMessageId: mapMessage(item.sourceMessageId),
				sourceToolCallId: null
			};
		}
		if (itemType === 'fact') {
			const item = value as MemoryFact;
			return {
				...item,
				id: mintId('fact', item.id),
				conversationId: targetConversationId,
				entityId: refId('entity', item.entityId),
				sourceEventId: refId('event', item.sourceEventId),
				sourceMessageId: mapMessage(item.sourceMessageId),
				supersedesFactId: refId('fact', item.supersedesFactId)
			};
		}
		if (itemType === 'open_loop') {
			const item = value as MemoryOpenLoop;
			return {
				...item,
				id: mintId('open_loop', item.id),
				conversationId: targetConversationId,
				relatedEntityIds: item.relatedEntityIds
					.map((id) => refId('entity', id))
					.filter((id): id is string => !!id),
				sourceEventId: refId('event', item.sourceEventId),
				sourceMessageId: mapMessage(item.sourceMessageId)
			};
		}
		if (itemType === 'patch') {
			const patch = value as MemoryPatch;
			return {
				...patch,
				id: mintId('patch', patch.id),
				conversationId: targetConversationId,
				turnId: null
			};
		}
		if (itemType === 'patch_item') {
			const item = value as MemoryPatchItem;
			return {
				...item,
				id: mintId('patch_item', item.id),
				patchId: refId('patch', item.patchId),
				conversationId: targetConversationId,
				itemId: refId(item.itemType, item.itemId) ?? item.itemId
			};
		}
		if (itemType === 'issue') {
			const issue = value as MemoryValidationIssue;
			return {
				...issue,
				id: mintId('issue', issue.id),
				conversationId: targetConversationId,
				patchId: refId('patch', issue.patchId)
			};
		}
		if (itemType === 'tool_call') {
			const toolCall = value as MemoryToolCall;
			return {
				...toolCall,
				id: mintId('tool_call', toolCall.id),
				conversationId: targetConversationId,
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
			const remapLoopIds = (value: unknown): string[] =>
				Array.isArray(value)
					? value
							.map((id) => (typeof id === 'string' ? refId('open_loop', id) : null))
							.filter((id): id is string => !!id)
					: [];
			result.presented = remapLoopIds(result.presented);
			result.kept = remapLoopIds(result.kept);
		}
		return result;
	};
}

function remapIdForPayload(
	itemType: SessionMemoryLogItemType,
	sourceItemId: string,
	payload: unknown
): string {
	const record = payloadObject(payload);
	const value = (record.item ?? record.patch ?? record.issue ?? record.toolCall) as
		| { id?: unknown }
		| undefined;
	return typeof value?.id === 'string' ? value.id : sourceItemId;
}

function indexItem(
	db: Database.Database,
	conversationId: string,
	itemType: string,
	itemId: string,
	text: string
) {
	db.prepare(
		'DELETE FROM memory_search_index WHERE conversation_id = ? AND item_type = ? AND item_id = ?'
	).run(conversationId, itemType, itemId);
	db.prepare(
		`INSERT INTO memory_search_index(conversation_id, item_type, item_id, text)
		 VALUES (?, ?, ?, ?)`
	).run(conversationId, itemType, itemId, text);
}

function syncSessionIndex(
	db: Database.Database,
	conversationId: string,
	itemType: string,
	itemId: string,
	status: string,
	text: string
) {
	if (shouldIndexSessionItem(itemType, status)) {
		indexItem(db, conversationId, itemType, itemId, text);
	} else {
		deleteSessionIndex(db, conversationId, itemType, itemId);
	}
}

function shouldIndexSessionItem(itemType: string, status: string): boolean {
	return itemType === 'open_loop' ? status === 'open' : status === 'active';
}

function deleteSessionIndex(
	db: Database.Database,
	conversationId: string,
	itemType: string,
	itemId: string
) {
	db.prepare(
		'DELETE FROM memory_search_index WHERE conversation_id = ? AND item_type = ? AND item_id = ?'
	).run(conversationId, itemType, itemId);
}

function indexGlobalMemory(db: Database.Database, userId: string, itemId: string, text: string) {
	db.prepare('DELETE FROM global_memory_search_index WHERE user_id = ? AND item_id = ?').run(
		userId,
		itemId
	);
	db.prepare(
		`INSERT INTO global_memory_search_index(user_id, item_id, text)
		 VALUES (?, ?, ?)`
	).run(userId, itemId, text);
}

function deleteGlobalIndex(db: Database.Database, userId: string, itemId: string) {
	db.prepare('DELETE FROM global_memory_search_index WHERE user_id = ? AND item_id = ?').run(
		userId,
		itemId
	);
}

function rowToEntity(row: EntityRow): MemoryEntity {
	return {
		id: row.id,
		conversationId: row.conversation_id,
		entityKey: row.entity_key,
		entityType: row.entity_type,
		displayName: row.display_name,
		summary: row.summary,
		status: row.status,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function rowToEvent(row: EventRow): MemoryEvent {
	return {
		id: row.id,
		conversationId: row.conversation_id,
		turnId: row.turn_id,
		eventType: row.event_type,
		occurredAt: row.occurred_at,
		actorEntityId: row.actor_entity_id,
		targetEntityId: row.target_entity_id,
		summary: row.summary,
		payload: parseJson(row.payload_json, {}),
		visibility: row.visibility,
		confidence: row.confidence,
		sourceMessageId: row.source_message_id,
		sourceToolCallId: row.source_tool_call_id,
		createdAt: row.created_at
	};
}

function rowToFact(row: FactRow): MemoryFact {
	return {
		id: row.id,
		conversationId: row.conversation_id,
		entityId: row.entity_id,
		predicate: row.predicate,
		value: parseJson(row.value_json, null),
		status: row.status,
		visibility: row.visibility,
		confidence: row.confidence,
		sourceEventId: row.source_event_id,
		sourceMessageId: row.source_message_id,
		supersedesFactId: row.supersedes_fact_id,
		pinned: Boolean(row.pinned),
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function rowToOpenLoop(row: OpenLoopRow): MemoryOpenLoop {
	return {
		id: row.id,
		conversationId: row.conversation_id,
		loopKey: row.loop_key ?? '',
		loopType: row.loop_type,
		title: row.title,
		description: row.description,
		status: row.status,
		priority: row.priority,
		relatedEntityIds: parseStringArray(row.related_entity_ids_json),
		sourceEventId: row.source_event_id,
		sourceMessageId: row.source_message_id,
		idleTurns: row.idle_turns ?? 0,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function rowToPatch(row: PatchRow): MemoryPatch {
	return {
		id: row.id,
		conversationId: row.conversation_id,
		turnId: row.turn_id,
		status: row.status,
		summary: row.summary,
		rawPatch: parseJson(row.raw_patch_json, {}),
		validationResult: parseJson(row.validation_result_json, {}),
		extractorKind: row.extractor_kind,
		extractorModel: row.extractor_model,
		extractorConfidence: row.extractor_confidence,
		extractorDiagnostics: parseJson(row.extractor_diagnostics_json ?? '[]', []),
		createdAt: row.created_at,
		committedAt: row.committed_at
	};
}

function rowToIssue(row: IssueRow): MemoryValidationIssue {
	return {
		id: row.id,
		conversationId: row.conversation_id,
		patchId: row.patch_id,
		severity: row.severity,
		code: row.code,
		message: row.message,
		status: row.status,
		createdAt: row.created_at,
		resolvedAt: row.resolved_at
	};
}

function rowToToolCall(row: ToolCallRow): MemoryToolCall {
	return {
		id: row.id,
		conversationId: row.conversation_id,
		turnId: row.turn_id,
		toolName: row.tool_name,
		arguments: parseJson(row.arguments_json, {}),
		resultSummary: row.result_summary,
		resultIds: parseStringArray(row.result_ids_json),
		createdAt: row.created_at
	};
}

function rowToPatchItem(row: PatchItemRow): MemoryPatchItem {
	return {
		id: row.id,
		patchId: row.patch_id,
		conversationId: row.conversation_id,
		itemType: row.item_type,
		itemId: row.item_id,
		action: row.action,
		reviewStatus: row.review_status,
		reviewedAt: row.reviewed_at,
		createdAt: row.created_at
	};
}

function rowToGlobalMemory(row: GlobalMemoryRow): GlobalMemory {
	return {
		id: row.id,
		userId: row.user_id,
		kind: row.kind,
		memoryKey: row.memory_key,
		value: parseJson(row.value_json, null),
		status: row.status,
		sourceConversationId: row.source_conversation_id,
		sourceMessageId: row.source_message_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function normalizeKind(kind: string): 'entity' | 'fact' | 'open_loop' | null {
	if (kind === 'entity' || kind === 'entities') return 'entity';
	if (kind === 'fact' || kind === 'facts') return 'fact';
	if (kind === 'open_loop' || kind === 'open-loops' || kind === 'openLoops') return 'open_loop';
	return null;
}

function parseJson(raw: string, fallback: unknown): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return fallback;
	}
}

function parseStringArray(raw: string): string[] {
	const parsed = parseJson(raw, []);
	return Array.isArray(parsed)
		? parsed.filter((item): item is string => typeof item === 'string')
		: [];
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value ?? null);
	} catch {
		return JSON.stringify(String(value));
	}
}

function ftsQuery(query: string): string {
	return query
		.split(/\s+/)
		.map((part) => part.replace(/"/g, ''))
		.filter(Boolean)
		.map((part) => `"${part}"`)
		.join(' OR ');
}

function entityIndexText(row: EntityRow): string {
	return [row.entity_key, row.entity_type, row.display_name, row.summary, row.metadata_json].join(
		'\n'
	);
}

function eventIndexText(row: EventRow): string {
	return [row.event_type, row.summary, row.payload_json].join('\n');
}

function factIndexText(row: FactRow): string {
	return [row.predicate, row.value_json].join('\n');
}

function openLoopIndexText(row: OpenLoopRow): string {
	return [row.loop_key, row.loop_type, row.title, row.description].join('\n');
}

function globalMemoryIndexText(row: GlobalMemoryRow): string {
	return [row.kind, row.memory_key, row.value_json].join('\n');
}
