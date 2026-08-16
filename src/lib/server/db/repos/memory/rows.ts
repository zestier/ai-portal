import {
	conversationId,
	memoryEntityId,
	memoryFactId,
	memoryPatchItemId,
	messageId,
	toolCallId,
	type IdCodec
} from '$lib/ids';
import type { MemoryMode } from '$lib/types';

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
	id: number;
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
	sourceEventId: number | null;
	sourceMessageId: string | null;
	supersedesFactId: string | null;
	pinned: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface MemoryOpenLoop {
	id: number;
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
	sourceEventId: number | null;
	sourceMessageId: string | null;
	idleTurns: number;
	createdAt: number;
	updatedAt: number;
}

export interface MemoryPatch {
	id: number;
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
	id: number;
	conversationId: string;
	patchId: number | null;
	severity: 'info' | 'warning' | 'error';
	code: string;
	message: string;
	status: string;
	createdAt: number;
	resolvedAt: number | null;
}

export interface MemoryToolCall {
	id: number;
	conversationId: string;
	turnId: string | null;
	toolName: string;
	arguments: unknown;
	resultSummary: string;
	resultIds: number[];
	createdAt: number;
}

export interface MemoryPatchItem {
	id: string;
	patchId: number;
	conversationId: string;
	itemType: string;
	itemId: string | number;
	action: string;
	reviewStatus: string;
	reviewedAt: number | null;
	createdAt: number;
}

export interface MemoryLogRow {
	seq: number;
	id: string;
	parent_id: string | null;
	conversation_id: number;
	event_kind: string;
	item_type: SessionMemoryLogItemType;
	item_id: number;
	source_message_id: number | null;
	turn_id: string | null;
	payload_json: string;
	created_at: number;
}

export type SessionMemoryLogItemType =
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
	id: number;
	userId: number;
	kind: string;
	memoryKey: string;
	value: unknown;
	status: string;
	sourceConversationId: string | null;
	sourceMessageId: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface EntityRow {
	id: number;
	conversation_id: number;
	entity_key: string;
	entity_type: string;
	display_name: string;
	summary: string;
	status: string;
	metadata_json: string;
	created_at: number;
	updated_at: number;
}

export interface EventRow {
	id: number;
	conversation_id: number;
	turn_id: string | null;
	event_type: string;
	occurred_at: number;
	actor_entity_id: number | null;
	target_entity_id: number | null;
	summary: string;
	payload_json: string;
	visibility: string;
	confidence: number;
	source_message_id: number | null;
	source_tool_call_id: number | null;
	created_at: number;
}

export interface FactRow {
	id: number;
	conversation_id: number;
	entity_id: number | null;
	predicate: string;
	value_json: string;
	status: string;
	visibility: string;
	confidence: number;
	source_event_id: number | null;
	source_message_id: number | null;
	supersedes_fact_id: number | null;
	pinned: number;
	created_at: number;
	updated_at: number;
}

export interface OpenLoopRow {
	id: number;
	conversation_id: number;
	loop_key: string;
	loop_type: string;
	title: string;
	description: string;
	status: string;
	priority: number;
	related_entity_ids_json: string;
	source_event_id: number | null;
	source_message_id: number | null;
	idle_turns: number;
	created_at: number;
	updated_at: number;
}

export interface PatchRow {
	id: number;
	conversation_id: number;
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

export interface IssueRow {
	id: number;
	conversation_id: number;
	patch_id: number | null;
	severity: 'info' | 'warning' | 'error';
	code: string;
	message: string;
	status: string;
	created_at: number;
	resolved_at: number | null;
}

export interface ToolCallRow {
	id: number;
	conversation_id: number;
	turn_id: string | null;
	tool_name: string;
	arguments_json: string;
	result_summary: string;
	result_ids_json: string;
	created_at: number;
}

export interface PatchItemRow {
	id: number;
	patch_id: number;
	conversation_id: number;
	item_type: string;
	item_id: number;
	action: string;
	review_status: string;
	reviewed_at: number | null;
	created_at: number;
}

export interface GlobalMemoryRow {
	id: number;
	user_id: number;
	kind: string;
	memory_key: string;
	value_json: string;
	status: string;
	source_conversation_id: number | null;
	source_message_id: number | null;
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
	globalMemories?: GlobalMemory[] | undefined;
}

export interface UpsertEntityInput {
	entityKey: string;
	entityType?: string | undefined;
	displayName?: string | undefined;
	summary?: string | undefined;
	metadata?: unknown;
	sourceMessageId?: number | null | undefined;
	turnId?: string | null | undefined;
}

export interface AddEventInput {
	turnId?: string | null | undefined;
	eventType: string;
	summary: string;
	payload?: unknown;
	visibility?: string | undefined;
	confidence?: number | undefined;
	sourceMessageId?: number | null | undefined;
	actorEntityId?: string | number | null | undefined;
	targetEntityId?: string | number | null | undefined;
}

export interface AddFactInput {
	entityId?: string | number | null | undefined;
	predicate: string;
	value: unknown;
	visibility?: string | undefined;
	confidence?: number | undefined;
	sourceEventId?: number | null | undefined;
	sourceMessageId?: number | null | undefined;
	supersedesFactId?: number | null | undefined;
	pinned?: boolean | undefined;
}

export interface AddOpenLoopInput {
	loopType: string;
	title: string;
	description?: string | undefined;
	priority?: number | undefined;
	relatedEntityIds?: Array<string | number> | undefined;
	sourceEventId?: number | null | undefined;
	sourceMessageId?: number | null | undefined;
}

export interface CreatePatchInput {
	turnId?: string | null | undefined;
	sourceMessageId?: number | null | undefined;
	status: MemoryPatchStatus;
	summary?: string | undefined;
	rawPatch?: unknown;
	validationResult?: unknown;
	extractorKind?: string | undefined;
	extractorModel?: string | undefined;
	extractorConfidence?: number | undefined;
	extractorDiagnostics?: unknown;
	committedAt?: number | null | undefined;
}

// Restrict `table` to the known projection table names so a non-literal (e.g. a
// future user-derived value) fails typecheck rather than being interpolated raw
// into the FROM clause — the only reason the `${table}` template is safe today.
export type SessionProjectionTable =
	| 'memory_entities'
	| 'memory_events'
	| 'memory_facts'
	| 'memory_open_loops';

// Resolve a conversation-id argument to its storage int (handles parse here).
export function convInt(id: string | number): number {
	return typeof id === 'number' ? id : conversationId.parse(id);
}

export function msgIntOf(id: string | number | null | undefined): number | null {
	if (id === null || id === undefined) return null;
	return typeof id === 'number' ? id : messageId.parse(id);
}

// Resolve a possibly-handle id reference to its int form. Repo inputs accept
// both `number` (raw int) and the opaque handle string; the SQL layer only
// ever sees ints.
export function resolveId(ref: string | number | null | undefined, codec: IdCodec): number | null {
	if (ref === null || ref === undefined) return null;
	if (typeof ref === 'number') return Number.isSafeInteger(ref) && ref > 0 ? ref : null;
	return codec.tryParse(ref);
}

// The event log stores repo-shaped snapshots (which now carry opaque handle
// ids). Replaying one means parsing the handles back to the ints the
// projection tables need. Tolerant of legacy rows that stored raw ints.
export function toIntId(value: unknown, codec: IdCodec): number | null {
	if (value === null || value === undefined) return null;
	if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
	if (typeof value !== 'string') return null;
	return codec.tryParse(value);
}

// Which session-memory item types carry opaque handle ids (see `$lib/ids`).
// Event/open_loop/patch/issue/tool_call ids are not prefixed and stay ints.
export const ID_CODECS: Partial<Record<SessionMemoryLogItemType, IdCodec>> = {
	entity: memoryEntityId,
	fact: memoryFactId,
	patch_item: memoryPatchItemId
};

export function codecFor(type: string): IdCodec | undefined {
	return ID_CODECS[type as SessionMemoryLogItemType];
}

// Normalize a patch item's target reference to the storage int. Fact/entity
// targets arrive as E/F-handles on the wire and are parsed back; event/open-loop
// targets have no handle prefix and pass through (event refs are opaque ULIDs
// the projection stores verbatim).
export function patchItemTargetId(item: { itemType: string; itemId: string | number }): number {
	const codec = codecFor(item.itemType);
	if (codec) return resolveId(item.itemId, codec) ?? 0;
	return typeof item.itemId === 'number' ? item.itemId : Number(item.itemId) || 0;
}

function maybeEnc(v: number | null | undefined, encode: (id: number) => string): string | null {
	return v === null || v === undefined ? null : encode(v);
}

export function rowToEntity(row: EntityRow): MemoryEntity {
	return {
		id: memoryEntityId.encode(row.id),
		conversationId: conversationId.encode(row.conversation_id),
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

export function rowToEvent(row: EventRow): MemoryEvent {
	return {
		id: row.id,
		conversationId: conversationId.encode(row.conversation_id),
		turnId: row.turn_id,
		eventType: row.event_type,
		occurredAt: row.occurred_at,
		actorEntityId: maybeEnc(row.actor_entity_id, memoryEntityId.encode),
		targetEntityId: maybeEnc(row.target_entity_id, memoryEntityId.encode),
		summary: row.summary,
		payload: parseJson(row.payload_json, {}),
		visibility: row.visibility,
		confidence: row.confidence,
		sourceMessageId: maybeEnc(row.source_message_id, messageId.encode),
		sourceToolCallId: maybeEnc(row.source_tool_call_id, toolCallId.encode),
		createdAt: row.created_at
	};
}

export function rowToFact(row: FactRow): MemoryFact {
	return {
		id: memoryFactId.encode(row.id),
		conversationId: conversationId.encode(row.conversation_id),
		entityId: maybeEnc(row.entity_id, memoryEntityId.encode),
		predicate: row.predicate,
		value: parseJson(row.value_json, null),
		status: row.status,
		visibility: row.visibility,
		confidence: row.confidence,
		sourceEventId: row.source_event_id,
		sourceMessageId: maybeEnc(row.source_message_id, messageId.encode),
		supersedesFactId: maybeEnc(row.supersedes_fact_id, memoryFactId.encode),
		pinned: Boolean(row.pinned),
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

export function rowToOpenLoop(row: OpenLoopRow): MemoryOpenLoop {
	return {
		id: row.id,
		conversationId: conversationId.encode(row.conversation_id),
		loopKey: row.loop_key ?? '',
		loopType: row.loop_type,
		title: row.title,
		description: row.description,
		status: row.status,
		priority: row.priority,
		relatedEntityIds: parseNumberArray(row.related_entity_ids_json).map((id) =>
			memoryEntityId.encode(id)
		),
		sourceEventId: row.source_event_id,
		sourceMessageId: maybeEnc(row.source_message_id, messageId.encode),
		idleTurns: row.idle_turns ?? 0,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

export function rowToPatch(row: PatchRow): MemoryPatch {
	return {
		id: row.id,
		conversationId: conversationId.encode(row.conversation_id),
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

export function rowToIssue(row: IssueRow): MemoryValidationIssue {
	return {
		id: row.id,
		conversationId: conversationId.encode(row.conversation_id),
		patchId: row.patch_id,
		severity: row.severity,
		code: row.code,
		message: row.message,
		status: row.status,
		createdAt: row.created_at,
		resolvedAt: row.resolved_at
	};
}

export function rowToToolCall(row: ToolCallRow): MemoryToolCall {
	return {
		id: row.id,
		conversationId: conversationId.encode(row.conversation_id),
		turnId: row.turn_id,
		toolName: row.tool_name,
		arguments: parseJson(row.arguments_json, {}),
		resultSummary: row.result_summary,
		resultIds: parseNumberArray(row.result_ids_json),
		createdAt: row.created_at
	};
}

export function rowToPatchItem(row: PatchItemRow): MemoryPatchItem {
	const codec = codecFor(row.item_type);
	return {
		id: memoryPatchItemId.encode(row.id),
		patchId: row.patch_id,
		conversationId: conversationId.encode(row.conversation_id),
		itemType: row.item_type,
		itemId: codec ? codec.encode(row.item_id) : row.item_id,
		action: row.action,
		reviewStatus: row.review_status,
		reviewedAt: row.reviewed_at,
		createdAt: row.created_at
	};
}

export function rowToGlobalMemory(row: GlobalMemoryRow): GlobalMemory {
	return {
		id: row.id,
		userId: row.user_id,
		kind: row.kind,
		memoryKey: row.memory_key,
		value: parseJson(row.value_json, null),
		status: row.status,
		sourceConversationId: maybeEnc(row.source_conversation_id, conversationId.encode),
		sourceMessageId: maybeEnc(row.source_message_id, messageId.encode),
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

export function normalizeKind(kind: string): 'entity' | 'fact' | 'open_loop' | null {
	if (kind === 'entity' || kind === 'entities') return 'entity';
	if (kind === 'fact' || kind === 'facts') return 'fact';
	if (kind === 'open_loop' || kind === 'open-loops' || kind === 'openLoops') return 'open_loop';
	return null;
}

export function parseJson(raw: string, fallback: unknown): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return fallback;
	}
}

export function parseNumberArray(raw: string): number[] {
	const parsed = parseJson(raw, []);
	return Array.isArray(parsed)
		? parsed.filter((item): item is number => typeof item === 'number')
		: [];
}

export function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value ?? null);
	} catch {
		return JSON.stringify(String(value));
	}
}
