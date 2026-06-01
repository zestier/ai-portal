import type Database from 'better-sqlite3';
import { ulid } from '../ids';
import { getDb } from '../index';
import { normalizeMemoryMode, type MemoryMode } from '$lib/types';
import {
	LOCAL_EMBEDDING_MODEL,
	cosineSimilarity,
	localHashEmbedding,
	textHash
} from '$lib/server/memory/embeddings';

export type MemoryItemStatus = 'active' | 'superseded' | 'disputed' | 'deleted';
export type MemoryPatchStatus =
	| 'draft'
	| 'committed'
	| 'partially_committed'
	| 'rejected'
	| 'needs_review'
	| 'reverted';

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
	createdAt: number;
	updatedAt: number;
}

export interface MemoryOpenLoop {
	id: string;
	conversationId: string;
	loopType: string;
	title: string;
	description: string;
	status: string;
	priority: number;
	relatedEntityIds: string[];
	sourceEventId: string | null;
	sourceMessageId: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface MemoryDecision {
	id: string;
	conversationId: string;
	subject: string;
	decision: string;
	rationale: string;
	status: string;
	sourceEventId: string | null;
	sourceMessageId: string | null;
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

export interface MemoryEmbedding {
	id: string;
	conversationId: string | null;
	userId: string | null;
	scope: 'session' | 'global';
	itemType: string;
	itemId: string;
	embeddingModel: string;
	dimensions: number;
	textHash: string;
	text: string;
	vector: number[];
	createdAt: number;
	updatedAt: number;
}

interface VecMapRow {
	embedding_id: string;
	dimensions: number;
	vec_rowid: number;
}

export interface VectorAccelerationStatus {
	available: boolean;
	provider: 'sqlite-vec' | 'json-fallback';
	message: string;
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
	created_at: number;
	updated_at: number;
}

interface OpenLoopRow {
	id: string;
	conversation_id: string;
	loop_type: string;
	title: string;
	description: string;
	status: string;
	priority: number;
	related_entity_ids_json: string;
	source_event_id: string | null;
	source_message_id: string | null;
	created_at: number;
	updated_at: number;
}

interface DecisionRow {
	id: string;
	conversation_id: string;
	subject: string;
	decision: string;
	rationale: string;
	status: string;
	source_event_id: string | null;
	source_message_id: string | null;
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

interface EmbeddingRow {
	id: string;
	conversation_id: string | null;
	user_id: string | null;
	scope: 'session' | 'global';
	item_type: string;
	item_id: string;
	embedding_model: string;
	dimensions: number;
	text_hash: string;
	text: string;
	vector_json: string;
	created_at: number;
	updated_at: number;
}

export interface MemorySnapshot {
	mode: MemoryMode;
	entities: MemoryEntity[];
	facts: MemoryFact[];
	decisions: MemoryDecision[];
	openLoops: MemoryOpenLoop[];
	events: MemoryEvent[];
	patches: MemoryPatch[];
	issues: MemoryValidationIssue[];
	toolCalls: MemoryToolCall[];
	patchItems: MemoryPatchItem[];
	globalMemories?: GlobalMemory[];
	vectorAcceleration: VectorAccelerationStatus;
}

export interface UpsertEntityInput {
	entityKey: string;
	entityType: string;
	displayName: string;
	summary?: string;
	metadata?: unknown;
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
}

export interface AddDecisionInput {
	subject: string;
	decision: string;
	rationale?: string;
	sourceEventId?: string | null;
	sourceMessageId?: string | null;
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
		decisions: listDecisions(conversationId, { limit: 100 }),
		openLoops: listOpenLoops(conversationId, { status: 'open', limit: 100 }),
		events: listEvents(conversationId, { limit: 100 }),
		patches: listPatches(conversationId, { limit: 50 }),
		issues: listIssues(conversationId, { limit: 100 }),
		toolCalls: listToolCalls(conversationId, { limit: 50 }),
		patchItems: listPatchItems(conversationId, { limit: 200 }),
		globalMemories: opts.userId ? listGlobalMemories(opts.userId, { limit: 100 }) : undefined,
		vectorAcceleration: vectorAccelerationStatus()
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
			input.entityType,
			input.displayName,
			input.summary ?? existing.summary,
			safeJson(input.metadata ?? parseJson(existing.metadata_json, {})),
			now,
			existing.id
		);
		const updated = db
			.prepare('SELECT * FROM memory_entities WHERE id = ?')
			.get(existing.id) as EntityRow;
		indexItem(db, conversationId, 'entity', existing.id, entityIndexText(updated));
		indexSessionMemoryItem(conversationId, 'entity', existing.id, entityIndexText(updated));
		return rowToEntity(updated);
	}
	const id = ulid();
	db.prepare(
		`INSERT INTO memory_entities(
		   id, conversation_id, entity_key, entity_type, display_name, summary, status,
		   metadata_json, created_at, updated_at
		 ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
	).run(
		id,
		conversationId,
		input.entityKey,
		input.entityType,
		input.displayName,
		input.summary ?? '',
		safeJson(input.metadata ?? {}),
		now,
		now
	);
	const row = db.prepare('SELECT * FROM memory_entities WHERE id = ?').get(id) as EntityRow;
	indexItem(db, conversationId, 'entity', id, entityIndexText(row));
	indexSessionMemoryItem(conversationId, 'entity', id, entityIndexText(row));
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
	indexSessionMemoryItem(conversationId, 'event', id, eventIndexText(row));
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
	const id = ulid();
	const now = Date.now();
	getDb()
		.prepare(
			`INSERT INTO memory_facts(
			   id, conversation_id, entity_id, predicate, value_json, status, visibility,
			   confidence, source_event_id, source_message_id, supersedes_fact_id, created_at,
			   updated_at
			 ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
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
			now,
			now
		);
	const row = getDb().prepare('SELECT * FROM memory_facts WHERE id = ?').get(id) as FactRow;
	indexItem(getDb(), conversationId, 'fact', id, factIndexText(row));
	indexSessionMemoryItem(conversationId, 'fact', id, factIndexText(row));
	return rowToFact(row);
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

export function addDecision(conversationId: string, input: AddDecisionInput): MemoryDecision {
	const id = ulid();
	const now = Date.now();
	getDb()
		.prepare(
			`INSERT INTO memory_decisions(
			   id, conversation_id, subject, decision, rationale, status, source_event_id,
			   source_message_id, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
		)
		.run(
			id,
			conversationId,
			input.subject,
			input.decision,
			input.rationale ?? '',
			input.sourceEventId ?? null,
			input.sourceMessageId ?? null,
			now,
			now
		);
	const row = getDb().prepare('SELECT * FROM memory_decisions WHERE id = ?').get(id) as DecisionRow;
	indexItem(getDb(), conversationId, 'decision', id, decisionIndexText(row));
	indexSessionMemoryItem(conversationId, 'decision', id, decisionIndexText(row));
	return rowToDecision(row);
}

export function listDecisions(
	conversationId: string,
	opts: { limit?: number; status?: string } = {}
): MemoryDecision[] {
	const rows = getDb()
		.prepare(
			`SELECT * FROM memory_decisions
			  WHERE conversation_id = ? AND status = ?
			  ORDER BY updated_at DESC LIMIT ?`
		)
		.all(conversationId, opts.status ?? 'active', opts.limit ?? 50) as DecisionRow[];
	return rows.map(rowToDecision);
}

export function addOpenLoop(conversationId: string, input: AddOpenLoopInput): MemoryOpenLoop {
	const id = ulid();
	const now = Date.now();
	getDb()
		.prepare(
			`INSERT INTO memory_open_loops(
			   id, conversation_id, loop_type, title, description, status, priority,
			   related_entity_ids_json, source_event_id, source_message_id, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`
		)
		.run(
			id,
			conversationId,
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
	indexSessionMemoryItem(conversationId, 'open_loop', id, openLoopIndexText(row));
	return rowToOpenLoop(row);
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
	return rowToPatch(
		getDb().prepare('SELECT * FROM memory_patches WHERE id = ?').get(id) as PatchRow
	);
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
	return rowToPatch(
		getDb()
			.prepare('SELECT * FROM memory_patches WHERE id = ? AND conversation_id = ?')
			.get(patchId, conversationId) as PatchRow
	);
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
	return rowToPatchItem(
		getDb().prepare('SELECT * FROM memory_patch_items WHERE id = ?').get(id) as PatchItemRow
	);
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
	return rowToEntity(row);
}

export function updateFact(
	conversationId: string,
	id: string,
	patch: Partial<Pick<MemoryFact, 'predicate' | 'value' | 'status' | 'visibility' | 'confidence'>>
): MemoryFact | null {
	const current = getDb()
		.prepare('SELECT * FROM memory_facts WHERE id = ? AND conversation_id = ?')
		.get(id, conversationId) as FactRow | undefined;
	if (!current) return null;
	getDb()
		.prepare(
			`UPDATE memory_facts
			    SET predicate = ?, value_json = ?, status = ?, visibility = ?, confidence = ?, updated_at = ?
			  WHERE id = ? AND conversation_id = ?`
		)
		.run(
			patch.predicate ?? current.predicate,
			patch.value === undefined ? current.value_json : safeJson(patch.value),
			patch.status ?? current.status,
			patch.visibility ?? current.visibility,
			patch.confidence ?? current.confidence,
			Date.now(),
			id,
			conversationId
		);
	const row = getDb()
		.prepare('SELECT * FROM memory_facts WHERE id = ? AND conversation_id = ?')
		.get(id, conversationId) as FactRow;
	syncSessionIndex(getDb(), conversationId, 'fact', id, row.status, factIndexText(row));
	return rowToFact(row);
}

export function updateDecision(
	conversationId: string,
	id: string,
	patch: Partial<Pick<MemoryDecision, 'subject' | 'decision' | 'rationale' | 'status'>>
): MemoryDecision | null {
	const current = getDb()
		.prepare('SELECT * FROM memory_decisions WHERE id = ? AND conversation_id = ?')
		.get(id, conversationId) as DecisionRow | undefined;
	if (!current) return null;
	getDb()
		.prepare(
			`UPDATE memory_decisions
			    SET subject = ?, decision = ?, rationale = ?, status = ?, updated_at = ?
			  WHERE id = ? AND conversation_id = ?`
		)
		.run(
			patch.subject ?? current.subject,
			patch.decision ?? current.decision,
			patch.rationale ?? current.rationale,
			patch.status ?? current.status,
			Date.now(),
			id,
			conversationId
		);
	const row = getDb()
		.prepare('SELECT * FROM memory_decisions WHERE id = ? AND conversation_id = ?')
		.get(id, conversationId) as DecisionRow;
	syncSessionIndex(getDb(), conversationId, 'decision', id, row.status, decisionIndexText(row));
	return rowToDecision(row);
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
	return rowToOpenLoop(row);
}

export function deleteItem(conversationId: string, kind: string, id: string): boolean {
	const normalized = normalizeKind(kind);
	if (!normalized) return false;
	if (normalized === 'entity')
		return updateEntity(conversationId, id, { status: 'deleted' }) !== null;
	if (normalized === 'fact') return updateFact(conversationId, id, { status: 'deleted' }) !== null;
	if (normalized === 'decision')
		return updateDecision(conversationId, id, { status: 'deleted' }) !== null;
	if (normalized === 'open_loop')
		return updateOpenLoop(conversationId, id, { status: 'deleted' }) !== null;
	return false;
}

export function revertPatch(
	conversationId: string,
	patchId: string
): {
	patch: MemoryPatch | null;
	reverted: number;
	skipped: number;
} {
	const patch = getDb()
		.prepare('SELECT * FROM memory_patches WHERE id = ? AND conversation_id = ?')
		.get(patchId, conversationId) as PatchRow | undefined;
	if (!patch) return { patch: null, reverted: 0, skipped: 0 };
	const items = listPatchItems(conversationId, { patchId, limit: 1000 });
	let reverted = 0;
	let skipped = 0;
	for (const item of items) {
		if (item.action !== 'create') {
			skipped++;
			continue;
		}
		const ok = deleteItem(conversationId, item.itemType, item.itemId);
		if (ok) reverted++;
		else skipped++;
	}
	const updated = updatePatchStatus(conversationId, patchId, 'reverted', {
		revertedAt: Date.now(),
		reverted,
		skipped
	});
	addEvent(conversationId, {
		eventType: 'memory_patch_reverted',
		summary: `Reverted memory patch ${patchId}.`,
		payload: { patchId, reverted, skipped },
		confidence: 1
	});
	return { patch: updated, reverted, skipped };
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
		indexGlobalMemoryItem(userId, 'global_memory', updated.id, globalMemoryIndexText(updated));
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
	indexGlobalMemoryItem(userId, 'global_memory', id, globalMemoryIndexText(row));
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
	indexGlobalMemoryItem(userId, 'global_memory', updated.id, globalMemoryIndexText(updated));
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

export function upsertEmbedding(input: {
	conversationId?: string | null;
	userId?: string | null;
	scope: 'session' | 'global';
	itemType: string;
	itemId: string;
	text: string;
	embeddingModel: string;
	vector: number[];
}): MemoryEmbedding {
	const db = getDb();
	const now = Date.now();
	const hash = textHash(input.text);
	const dimensions = input.vector.length;
	const existing = db
		.prepare(
			`SELECT * FROM memory_embeddings
			  WHERE scope = ? AND item_type = ? AND item_id = ? AND embedding_model = ?`
		)
		.get(input.scope, input.itemType, input.itemId, input.embeddingModel) as
		| EmbeddingRow
		| undefined;
	if (existing) {
		db.prepare(
			`UPDATE memory_embeddings
			    SET conversation_id = ?, user_id = ?, dimensions = ?, text_hash = ?, text = ?,
			        vector_json = ?, updated_at = ?
			  WHERE id = ?`
		).run(
			input.conversationId ?? null,
			input.userId ?? null,
			dimensions,
			hash,
			input.text,
			safeJson(input.vector),
			now,
			existing.id
		);
		const updated = db
			.prepare('SELECT * FROM memory_embeddings WHERE id = ?')
			.get(existing.id) as EmbeddingRow;
		syncVecIndex(db, updated.id, dimensions, input.vector);
		return rowToEmbedding(updated);
	}
	const id = ulid();
	db.prepare(
		`INSERT INTO memory_embeddings(
		   id, conversation_id, user_id, scope, item_type, item_id, embedding_model,
		   dimensions, text_hash, text, vector_json, created_at, updated_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		id,
		input.conversationId ?? null,
		input.userId ?? null,
		input.scope,
		input.itemType,
		input.itemId,
		input.embeddingModel,
		dimensions,
		hash,
		input.text,
		safeJson(input.vector),
		now,
		now
	);
	const row = db.prepare('SELECT * FROM memory_embeddings WHERE id = ?').get(id) as EmbeddingRow;
	syncVecIndex(db, id, dimensions, input.vector);
	return rowToEmbedding(row);
}

export function indexEmbedding(input: {
	conversationId?: string | null;
	userId?: string | null;
	scope: 'session' | 'global';
	itemType: string;
	itemId: string;
	text: string;
}): MemoryEmbedding {
	return upsertEmbedding({
		...input,
		embeddingModel: LOCAL_EMBEDDING_MODEL,
		vector: localHashEmbedding(input.text)
	});
}

export function indexSessionMemoryItem(
	conversationId: string,
	itemType: string,
	itemId: string,
	text: string
): void {
	indexEmbedding({ conversationId, scope: 'session', itemType, itemId, text });
}

export function indexGlobalMemoryItem(
	userId: string,
	itemType: string,
	itemId: string,
	text: string
): void {
	indexEmbedding({ userId, scope: 'global', itemType, itemId, text });
}

export function searchEmbeddings(
	conversationId: string,
	opts: { query: string; types?: string[]; limit?: number }
): Array<{ itemType: string; itemId: string; text: string; score: number; sources: string[] }> {
	const queryVector = localHashEmbedding(opts.query);
	const accelerated = searchVecEmbeddings(conversationId, queryVector, opts);
	if (accelerated.length > 0) return accelerated;
	const rows = getDb()
		.prepare(
			`SELECT * FROM memory_embeddings
			  WHERE scope = 'session' AND conversation_id = ?
			  ORDER BY updated_at DESC LIMIT 1000`
		)
		.all(conversationId) as EmbeddingRow[];
	const types = new Set(opts.types ?? []);
	return rows
		.filter((row) => types.size === 0 || types.has(row.item_type))
		.map((row) => {
			const embedding = rowToEmbedding(row);
			return {
				itemType: embedding.itemType,
				itemId: embedding.itemId,
				text: embedding.text,
				score: cosineSimilarity(queryVector, embedding.vector) * 5,
				sources: ['vector']
			};
		})
		.filter((result) => result.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, opts.limit ?? 20);
}

export function vectorAccelerationStatus(): VectorAccelerationStatus {
	try {
		const row = getDb().prepare('SELECT vec_version() AS version').get() as
			| { version?: unknown }
			| undefined;
		const version = typeof row?.version === 'string' ? row.version : 'unknown';
		return {
			available: true,
			provider: 'sqlite-vec',
			message: `sqlite-vec available (${version})`
		};
	} catch {
		return {
			available: false,
			provider: 'json-fallback',
			message: 'sqlite-vec unavailable; using JSON-vector cosine fallback.'
		};
	}
}

function searchVecEmbeddings(
	conversationId: string,
	queryVector: number[],
	opts: { types?: string[]; limit?: number }
): Array<{ itemType: string; itemId: string; text: string; score: number; sources: string[] }> {
	const db = getDb();
	if (!hasSqliteVec(db)) return [];
	const dimensions = queryVector.length;
	const table = vecTableName(dimensions);
	ensureVecSchema(db, dimensions);
	const types = new Set(opts.types ?? []);
	const rows = db
		.prepare(
			`SELECT e.*, v.distance AS distance
			   FROM ${table} AS v
			   JOIN memory_embedding_vec_map AS m
			     ON m.dimensions = ? AND m.vec_rowid = v.rowid
			   JOIN memory_embeddings AS e
			     ON e.id = m.embedding_id
			  WHERE v.embedding MATCH ?
			    AND k = ?
			    AND e.scope = 'session'
			    AND e.conversation_id = ?`
		)
		.all(
			dimensions,
			safeJson(queryVector),
			Math.max(opts.limit ?? 20, 20),
			conversationId
		) as Array<EmbeddingRow & { distance: number }>;
	return rows
		.filter((row) => types.size === 0 || types.has(row.item_type))
		.map((row) => ({
			itemType: row.item_type,
			itemId: row.item_id,
			text: row.text,
			score: Math.max(0, 5 - row.distance),
			sources: ['sqlite-vec']
		}))
		.filter((result) => result.score > 0)
		.slice(0, opts.limit ?? 20);
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
	return rowToIssue(
		getDb().prepare('SELECT * FROM memory_validation_issues WHERE id = ?').get(id) as IssueRow
	);
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
	return rowToToolCall(
		getDb().prepare('SELECT * FROM memory_tool_calls WHERE id = ?').get(id) as ToolCallRow
	);
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
	opts: { query: string; types?: string[]; limit?: number; includeVector?: boolean }
): Array<{ itemType: string; itemId: string; text: string; score?: number; sources?: string[] }> {
	const query = opts.query.trim();
	if (!query) return [];
	const limit = opts.limit ?? 20;
	const rows = getDb()
		.prepare(
			`SELECT item_type, item_id, text
			   FROM memory_search_index
			  WHERE conversation_id = ?
			    AND memory_search_index MATCH ?
			  ORDER BY rank
			  LIMIT ?`
		)
		.all(conversationId, ftsQuery(query), limit) as {
		item_type: string;
		item_id: string;
		text: string;
	}[];
	const types = new Set(opts.types ?? []);
	const lexical = rows
		.filter((row) => types.size === 0 || types.has(row.item_type))
		.map((row, index) => ({
			itemType: row.item_type,
			itemId: row.item_id,
			text: row.text,
			score: limit - index,
			sources: ['fts']
		}));
	if (opts.includeVector === false) return lexical;
	const vector = searchEmbeddings(conversationId, { query, types: opts.types, limit });
	return mergeSearchResults([...lexical, ...vector]).slice(0, limit);
}

export function wipe(conversationId: string): void {
	const db = getDb();
	const tx = db.transaction(() => {
		const embeddingIds = db
			.prepare(
				`SELECT id FROM memory_embeddings
				  WHERE scope = 'session' AND conversation_id = ?`
			)
			.all(conversationId) as { id: string }[];
		for (const row of embeddingIds) deleteVecIndex(db, row.id);
		db.prepare('DELETE FROM memory_search_index WHERE conversation_id = ?').run(conversationId);
		db.prepare('DELETE FROM memory_patch_items WHERE conversation_id = ?').run(conversationId);
		db.prepare('DELETE FROM memory_tool_calls WHERE conversation_id = ?').run(conversationId);
		db.prepare('DELETE FROM memory_validation_issues WHERE conversation_id = ?').run(
			conversationId
		);
		db.prepare('DELETE FROM memory_patches WHERE conversation_id = ?').run(conversationId);
		db.prepare('DELETE FROM memory_decisions WHERE conversation_id = ?').run(conversationId);
		db.prepare('DELETE FROM memory_open_loops WHERE conversation_id = ?').run(conversationId);
		db.prepare('DELETE FROM memory_facts WHERE conversation_id = ?').run(conversationId);
		db.prepare('DELETE FROM memory_events WHERE conversation_id = ?').run(conversationId);
		db.prepare('DELETE FROM memory_entities WHERE conversation_id = ?').run(conversationId);
		db.prepare(
			`DELETE FROM memory_embeddings
			  WHERE scope = 'session' AND conversation_id = ?`
		).run(conversationId);
	});
	tx();
}

/**
 * Copy the live session-memory state of `sourceConversationId` into
 * `targetConversationId` when a conversation is forked (edit/retry rewind).
 *
 * Memory is cloned by *prefix membership*: any item linked to a kept prefix
 * message (via `source_message_id`, translated through `messageIdMap`) carries
 * over, while items linked to discarded suffix messages do not. Items that have
 * no message link (entities, and any orphaned rows) fall back to the
 * `createdBefore` boundary — the `created_at` of the first DISCARDED source
 * message. Membership is used in preference to the timestamp because extraction
 * runs asynchronously after a turn, so a prefix item can legitimately be
 * committed after the next message's timestamp; classifying by the message link
 * avoids dropping such items while still never leaking discarded memory.
 *
 * Internal references are remapped to the clone: entity/event ids are reissued
 * and rewired, and `source_message_id` is translated through `messageIdMap`
 * (old prefix message id → freshly cloned message id) so memory stays linked to
 * the fork's own transcript. Patches, patch items, validation issues, and tool
 * calls are intentionally NOT copied — the fork inherits memory *state* as a
 * fresh baseline and starts its own patch history.
 */
export function cloneSessionMemoryForFork(
	sourceConversationId: string,
	targetConversationId: string,
	opts: { messageIdMap: Map<string, string>; createdBefore?: number }
): { entities: number; events: number; facts: number; decisions: number; openLoops: number } {
	const db = getDb();
	const createdBefore = opts.createdBefore ?? Number.POSITIVE_INFINITY;
	const counts = { entities: 0, events: 0, facts: 0, decisions: 0, openLoops: 0 };
	const mapMessageId = (old: string | null): string | null =>
		old ? (opts.messageIdMap.get(old) ?? null) : null;
	// Decide whether a memory row belongs to the kept prefix. Rows that carry a
	// source_message_id are classified *exactly* by prefix membership, which is
	// robust to extraction timing (async post-turn extraction can commit a
	// prefix item after the next user message's timestamp). Only rows with no
	// message link fall back to the created_at boundary.
	const keepLinked = (sourceMessageId: string | null, createdAt: number): boolean =>
		sourceMessageId != null ? opts.messageIdMap.has(sourceMessageId) : createdAt < createdBefore;

	const tx = db.transaction(() => {
		// Entities (active state). No source_message_id column, so they're
		// filtered purely by the created_at boundary.
		const entityRows = db
			.prepare(
				`SELECT * FROM memory_entities
				  WHERE conversation_id = ? AND status = 'active' AND created_at < ?`
			)
			.all(sourceConversationId, createdBefore) as EntityRow[];
		const entityIdMap = new Map<string, string>();
		const insertEntity = db.prepare(
			`INSERT INTO memory_entities(
			   id, conversation_id, entity_key, entity_type, display_name, summary, status,
			   metadata_json, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);
		for (const row of entityRows) {
			const newId = ulid();
			entityIdMap.set(row.id, newId);
			insertEntity.run(
				newId,
				targetConversationId,
				row.entity_key,
				row.entity_type,
				row.display_name,
				row.summary,
				row.status,
				row.metadata_json,
				row.created_at,
				row.updated_at
			);
			const cloned: EntityRow = { ...row, id: newId, conversation_id: targetConversationId };
			indexItem(db, targetConversationId, 'entity', newId, entityIndexText(cloned));
			indexSessionMemoryItem(targetConversationId, 'entity', newId, entityIndexText(cloned));
			counts.entities++;
		}

		// Events. turn_id is an ephemeral per-turn id with no meaning in the
		// fork, so it's dropped; entity references are remapped (dangling refs
		// to non-cloned entities become null). Classified by prefix membership
		// of source_message_id (created_at boundary only for unlinked rows).
		const eventRows = db
			.prepare(`SELECT * FROM memory_events WHERE conversation_id = ?`)
			.all(sourceConversationId) as EventRow[];
		const eventIdMap = new Map<string, string>();
		const insertEvent = db.prepare(
			`INSERT INTO memory_events(
			   id, conversation_id, turn_id, event_type, occurred_at, actor_entity_id,
			   target_entity_id, summary, payload_json, visibility, confidence,
			   source_message_id, source_tool_call_id, created_at
			 ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
		);
		for (const row of eventRows) {
			if (!keepLinked(row.source_message_id, row.created_at)) continue;
			const newId = ulid();
			eventIdMap.set(row.id, newId);
			insertEvent.run(
				newId,
				targetConversationId,
				row.event_type,
				row.occurred_at,
				row.actor_entity_id ? (entityIdMap.get(row.actor_entity_id) ?? null) : null,
				row.target_entity_id ? (entityIdMap.get(row.target_entity_id) ?? null) : null,
				row.summary,
				row.payload_json,
				row.visibility,
				row.confidence,
				mapMessageId(row.source_message_id),
				row.created_at
			);
			const cloned: EventRow = { ...row, id: newId, conversation_id: targetConversationId };
			indexItem(db, targetConversationId, 'event', newId, eventIndexText(cloned));
			indexSessionMemoryItem(targetConversationId, 'event', newId, eventIndexText(cloned));
			counts.events++;
		}

		// Facts (active). supersedes_fact_id is dropped because superseded facts
		// aren't cloned, so the chain pointer would dangle.
		const factRows = db
			.prepare(`SELECT * FROM memory_facts WHERE conversation_id = ? AND status = 'active'`)
			.all(sourceConversationId) as FactRow[];
		const insertFact = db.prepare(
			`INSERT INTO memory_facts(
			   id, conversation_id, entity_id, predicate, value_json, status, visibility,
			   confidence, source_event_id, source_message_id, supersedes_fact_id, created_at,
			   updated_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
		);
		for (const row of factRows) {
			if (!keepLinked(row.source_message_id, row.created_at)) continue;
			const newId = ulid();
			insertFact.run(
				newId,
				targetConversationId,
				row.entity_id ? (entityIdMap.get(row.entity_id) ?? null) : null,
				row.predicate,
				row.value_json,
				row.status,
				row.visibility,
				row.confidence,
				row.source_event_id ? (eventIdMap.get(row.source_event_id) ?? null) : null,
				mapMessageId(row.source_message_id),
				row.created_at,
				row.updated_at
			);
			const cloned: FactRow = { ...row, id: newId, conversation_id: targetConversationId };
			indexItem(db, targetConversationId, 'fact', newId, factIndexText(cloned));
			indexSessionMemoryItem(targetConversationId, 'fact', newId, factIndexText(cloned));
			counts.facts++;
		}

		// Decisions (active).
		const decisionRows = db
			.prepare(`SELECT * FROM memory_decisions WHERE conversation_id = ? AND status = 'active'`)
			.all(sourceConversationId) as DecisionRow[];
		const insertDecision = db.prepare(
			`INSERT INTO memory_decisions(
			   id, conversation_id, subject, decision, rationale, status, source_event_id,
			   source_message_id, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);
		for (const row of decisionRows) {
			if (!keepLinked(row.source_message_id, row.created_at)) continue;
			const newId = ulid();
			insertDecision.run(
				newId,
				targetConversationId,
				row.subject,
				row.decision,
				row.rationale,
				row.status,
				row.source_event_id ? (eventIdMap.get(row.source_event_id) ?? null) : null,
				mapMessageId(row.source_message_id),
				row.created_at,
				row.updated_at
			);
			const cloned: DecisionRow = { ...row, id: newId, conversation_id: targetConversationId };
			indexItem(db, targetConversationId, 'decision', newId, decisionIndexText(cloned));
			indexSessionMemoryItem(targetConversationId, 'decision', newId, decisionIndexText(cloned));
			counts.decisions++;
		}

		// Open loops (still open). Related entity refs are remapped and pruned
		// to those that were cloned.
		const openLoopRows = db
			.prepare(`SELECT * FROM memory_open_loops WHERE conversation_id = ? AND status = 'open'`)
			.all(sourceConversationId) as OpenLoopRow[];
		const insertOpenLoop = db.prepare(
			`INSERT INTO memory_open_loops(
			   id, conversation_id, loop_type, title, description, status, priority,
			   related_entity_ids_json, source_event_id, source_message_id, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);
		for (const row of openLoopRows) {
			if (!keepLinked(row.source_message_id, row.created_at)) continue;
			const newId = ulid();
			const relatedJson = safeJson(
				parseStringArray(row.related_entity_ids_json)
					.map((id) => entityIdMap.get(id))
					.filter((id): id is string => !!id)
			);
			insertOpenLoop.run(
				newId,
				targetConversationId,
				row.loop_type,
				row.title,
				row.description,
				row.status,
				row.priority,
				relatedJson,
				row.source_event_id ? (eventIdMap.get(row.source_event_id) ?? null) : null,
				mapMessageId(row.source_message_id),
				row.created_at,
				row.updated_at
			);
			const cloned: OpenLoopRow = {
				...row,
				id: newId,
				conversation_id: targetConversationId,
				related_entity_ids_json: relatedJson
			};
			indexItem(db, targetConversationId, 'open_loop', newId, openLoopIndexText(cloned));
			indexSessionMemoryItem(targetConversationId, 'open_loop', newId, openLoopIndexText(cloned));
			counts.openLoops++;
		}
	});
	tx();
	return counts;
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
		indexSessionMemoryItem(conversationId, itemType, itemId, text);
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
	const embeddingIds = db
		.prepare(
			`SELECT id FROM memory_embeddings
			  WHERE scope = 'session'
			    AND conversation_id = ?
			    AND item_type = ?
			    AND item_id = ?`
		)
		.all(conversationId, itemType, itemId) as { id: string }[];
	for (const row of embeddingIds) deleteVecIndex(db, row.id);
	db.prepare(
		'DELETE FROM memory_search_index WHERE conversation_id = ? AND item_type = ? AND item_id = ?'
	).run(conversationId, itemType, itemId);
	db.prepare(
		`DELETE FROM memory_embeddings
		  WHERE scope = 'session'
		    AND conversation_id = ?
		    AND item_type = ?
		    AND item_id = ?`
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
	const embeddingIds = db
		.prepare(
			`SELECT id FROM memory_embeddings
			  WHERE scope = 'global'
			    AND user_id = ?
			    AND item_id = ?`
		)
		.all(userId, itemId) as { id: string }[];
	for (const row of embeddingIds) deleteVecIndex(db, row.id);
	db.prepare('DELETE FROM global_memory_search_index WHERE user_id = ? AND item_id = ?').run(
		userId,
		itemId
	);
	db.prepare(
		`DELETE FROM memory_embeddings
		  WHERE scope = 'global'
		    AND user_id = ?
		    AND item_id = ?`
	).run(userId, itemId);
}

function syncVecIndex(
	db: Database.Database,
	embeddingId: string,
	dimensions: number,
	vector: number[]
): void {
	if (!hasSqliteVec(db) || dimensions <= 0) return;
	ensureVecSchema(db, dimensions);
	deleteVecIndex(db, embeddingId);
	const table = vecTableName(dimensions);
	const result = db.prepare(`INSERT INTO ${table}(embedding) VALUES (?)`).run(safeJson(vector));
	const rowid = Number(result.lastInsertRowid);
	db.prepare(
		`INSERT INTO memory_embedding_vec_map(embedding_id, dimensions, vec_rowid)
		 VALUES (?, ?, ?)`
	).run(embeddingId, dimensions, rowid);
}

function deleteVecIndex(db: Database.Database, embeddingId: string): void {
	if (!hasSqliteVec(db)) return;
	ensureVecMapTable(db);
	const rows = db
		.prepare('SELECT * FROM memory_embedding_vec_map WHERE embedding_id = ?')
		.all(embeddingId) as VecMapRow[];
	for (const row of rows) {
		const table = vecTableName(row.dimensions);
		try {
			db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(row.vec_rowid);
		} catch {
			/* Table may not exist if a failed/older deployment never created it. */
		}
	}
	db.prepare('DELETE FROM memory_embedding_vec_map WHERE embedding_id = ?').run(embeddingId);
}

function ensureVecSchema(db: Database.Database, dimensions: number): void {
	ensureVecMapTable(db);
	db.prepare(
		`CREATE VIRTUAL TABLE IF NOT EXISTS ${vecTableName(dimensions)}
		   USING vec0(embedding float[${dimensions}])`
	).run();
}

function ensureVecMapTable(db: Database.Database): void {
	db.prepare(
		`CREATE TABLE IF NOT EXISTS memory_embedding_vec_map (
		   embedding_id TEXT PRIMARY KEY REFERENCES memory_embeddings(id) ON DELETE CASCADE,
		   dimensions INTEGER NOT NULL,
		   vec_rowid INTEGER NOT NULL
		 )`
	).run();
}

function vecTableName(dimensions: number): string {
	if (!Number.isInteger(dimensions) || dimensions <= 0 || dimensions > 100_000) {
		throw new Error(`Invalid vector dimensions: ${dimensions}`);
	}
	return `memory_embedding_vec_${dimensions}`;
}

function hasSqliteVec(db: Database.Database): boolean {
	try {
		db.prepare('SELECT vec_version()').get();
		return true;
	} catch {
		return false;
	}
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
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function rowToOpenLoop(row: OpenLoopRow): MemoryOpenLoop {
	return {
		id: row.id,
		conversationId: row.conversation_id,
		loopType: row.loop_type,
		title: row.title,
		description: row.description,
		status: row.status,
		priority: row.priority,
		relatedEntityIds: parseStringArray(row.related_entity_ids_json),
		sourceEventId: row.source_event_id,
		sourceMessageId: row.source_message_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function rowToDecision(row: DecisionRow): MemoryDecision {
	return {
		id: row.id,
		conversationId: row.conversation_id,
		subject: row.subject,
		decision: row.decision,
		rationale: row.rationale,
		status: row.status,
		sourceEventId: row.source_event_id,
		sourceMessageId: row.source_message_id,
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

function rowToEmbedding(row: EmbeddingRow): MemoryEmbedding {
	const parsed = parseJson(row.vector_json, []);
	return {
		id: row.id,
		conversationId: row.conversation_id,
		userId: row.user_id,
		scope: row.scope,
		itemType: row.item_type,
		itemId: row.item_id,
		embeddingModel: row.embedding_model,
		dimensions: row.dimensions,
		textHash: row.text_hash,
		text: row.text,
		vector: Array.isArray(parsed)
			? parsed.filter((value): value is number => typeof value === 'number')
			: [],
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function normalizeKind(kind: string): 'entity' | 'fact' | 'decision' | 'open_loop' | null {
	if (kind === 'entity' || kind === 'entities') return 'entity';
	if (kind === 'fact' || kind === 'facts') return 'fact';
	if (kind === 'decision' || kind === 'decisions') return 'decision';
	if (kind === 'open_loop' || kind === 'open-loops' || kind === 'openLoops') return 'open_loop';
	return null;
}

function mergeSearchResults(
	results: Array<{
		itemType: string;
		itemId: string;
		text: string;
		score?: number;
		sources?: string[];
	}>
): Array<{ itemType: string; itemId: string; text: string; score: number; sources: string[] }> {
	const merged = new Map<
		string,
		{ itemType: string; itemId: string; text: string; score: number; sources: string[] }
	>();
	for (const result of results) {
		const key = `${result.itemType}:${result.itemId}`;
		const existing = merged.get(key);
		if (existing) {
			existing.score += result.score ?? 0;
			existing.sources = [...new Set([...existing.sources, ...(result.sources ?? [])])];
		} else {
			merged.set(key, {
				itemType: result.itemType,
				itemId: result.itemId,
				text: result.text,
				score: result.score ?? 0,
				sources: result.sources ?? []
			});
		}
	}
	return [...merged.values()].sort((a, b) => b.score - a.score);
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

function decisionIndexText(row: DecisionRow): string {
	return [row.subject, row.decision, row.rationale].join('\n');
}

function openLoopIndexText(row: OpenLoopRow): string {
	return [row.loop_type, row.title, row.description].join('\n');
}

function globalMemoryIndexText(row: GlobalMemoryRow): string {
	return [row.kind, row.memory_key, row.value_json].join('\n');
}
