import { getDb } from '../../index';
import { memoryEntityId } from '$lib/ids';
import { appendSessionMemoryLog, consolidateFactGroup } from './common';
import {
	convInt,
	parseJson,
	resolveId,
	rowToEntity,
	rowToEvent,
	rowToFact,
	safeJson,
	type EntityRow,
	type EventRow,
	type FactRow,
	type MemoryEntity,
	type OpenLoopRow,
	type UpsertEntityInput
} from './rows';
import {
	entityIndexText,
	eventIndexText,
	factIndexText,
	indexItem,
	syncSessionIndex
} from './search';
import { updateOpenLoop } from './loops';
import { addEvent } from './events';

export function upsertEntity(
	conversationId: string | number,
	input: UpsertEntityInput
): MemoryEntity {
	const db = getDb();
	const intConv = convInt(conversationId);
	const now = Date.now();
	// Read + write must live in the SAME transaction: a read outside the write
	// lets two concurrent callers (extraction retry, fork replay) both observe
	// existing=undefined for the same (conversation_id, entity_key) and race to
	// INSERT. The UNIQUE(conversation_id, entity_key) constraint (migration 025)
	// lets us collapse the read-derived values into a single atomic
	// INSERT ... ON CONFLICT DO UPDATE so the loser updates instead of throwing.
	const tx = db.transaction((): MemoryEntity => {
		const existing = db
			.prepare('SELECT * FROM memory_entities WHERE conversation_id = ? AND entity_key = ?')
			.get(intConv, input.entityKey) as EntityRow | undefined;
		// On INSERT the caller is responsible for resolving entityType/displayName
		// (the engine commit path derives them from the entityKey for a brand-new
		// entity — see deriveEntityFromKey). The `?? ''` is only a type-level guard;
		// legitimate new entities always arrive with both fields populated. On
		// UPDATE we fall back to the existing row's values when the input omits a
		// field, preserving the prior SELECT-then-UPDATE semantics.
		const entityType = input.entityType ?? existing?.entity_type ?? '';
		const displayName = input.displayName ?? existing?.display_name ?? '';
		const summary = input.summary ?? existing?.summary ?? '';
		const metadataJson = safeJson(
			input.metadata ?? (existing ? parseJson(existing.metadata_json, {}) : {})
		);
		db.prepare(
			`INSERT INTO memory_entities(
			   conversation_id, entity_key, entity_type, display_name, summary, status,
			   metadata_json, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
			 ON CONFLICT(conversation_id, entity_key) DO UPDATE SET
			   entity_type = excluded.entity_type,
			   display_name = excluded.display_name,
			   summary = excluded.summary,
			   metadata_json = excluded.metadata_json,
			   updated_at = excluded.updated_at`
		).run(intConv, input.entityKey, entityType, displayName, summary, metadataJson, now, now);
		const row = db
			.prepare('SELECT * FROM memory_entities WHERE conversation_id = ? AND entity_key = ?')
			.get(intConv, input.entityKey) as EntityRow;
		indexItem(db, intConv, 'entity', row.id, entityIndexText(row));
		appendSessionMemoryLog(db, intConv, {
			eventKind: existing ? 'entity.update' : 'entity.create',
			itemType: 'entity',
			itemId: row.id,
			sourceMessageId: input.sourceMessageId ?? null,
			turnId: input.turnId ?? null,
			payload: { item: rowToEntity(row) }
		});
		return rowToEntity(row);
	});
	return tx();
}

export function getEntity(
	conversationId: string | number,
	entityKeyOrId: string | number
): MemoryEntity | null {
	const intConv = convInt(conversationId);
	const id =
		typeof entityKeyOrId === 'string' ? memoryEntityId.tryParse(entityKeyOrId) : entityKeyOrId;
	const key = typeof entityKeyOrId === 'string' && id === null ? entityKeyOrId : null;
	const row = getDb()
		.prepare(
			`SELECT * FROM memory_entities
			  WHERE conversation_id = ? AND (id = ? OR entity_key = ?)
			  LIMIT 1`
		)
		.get(intConv, id ?? -1, key ?? '') as EntityRow | undefined;
	return row ? rowToEntity(row) : null;
}

export function listEntities(
	conversationId: string | number,
	opts: {
		limit?: number | undefined;
		entityType?: string | undefined;
		status?: string | undefined;
	} = {}
): MemoryEntity[] {
	const intConv = convInt(conversationId);
	const limit = opts.limit ?? 100;
	const status = opts.status ?? 'active';
	const rows = opts.entityType
		? (getDb()
				.prepare(
					`SELECT * FROM memory_entities
					  WHERE conversation_id = ? AND entity_type = ? AND status = ?
					  ORDER BY updated_at DESC LIMIT ?`
				)
				.all(intConv, opts.entityType, status, limit) as EntityRow[])
		: (getDb()
				.prepare(
					`SELECT * FROM memory_entities
					  WHERE conversation_id = ? AND status = ?
					  ORDER BY updated_at DESC LIMIT ?`
				)
				.all(intConv, status, limit) as EntityRow[]);
	return rows.map(rowToEntity);
}

/**
 * Count active facts per entity for a conversation. Powers the always-present
 * entity-key index in the turn packet (so the model knows how much is queryable
 * by name even when individual fact bodies are dropped from the packet).
 */
export function entityFactCounts(conversationId: number): Map<string, number> {
	const rows = getDb()
		.prepare(
			`SELECT entity_id AS entityId, COUNT(*) AS count
			   FROM memory_facts
			  WHERE conversation_id = ? AND status = 'active' AND entity_id IS NOT NULL
			  GROUP BY entity_id`
		)
		.all(conversationId) as Array<{ entityId: number; count: number }>;
	const counts = new Map<string, number>();
	for (const row of rows) counts.set(memoryEntityId.encode(row.entityId), row.count);
	return counts;
}

export function updateEntity(
	conversationId: string | number,
	id: string | number,
	patch: Partial<Pick<MemoryEntity, 'displayName' | 'summary' | 'status'>> & {
		entityType?: string;
		metadata?: unknown;
	}
): MemoryEntity | null {
	const intConv = convInt(conversationId);
	const intId = resolveId(id, memoryEntityId);
	if (!intId) return null;
	const current = getEntity(intConv, intId);
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
			intId,
			intConv
		);
	const row = getDb()
		.prepare('SELECT * FROM memory_entities WHERE id = ? AND conversation_id = ?')
		.get(intId, intConv) as EntityRow;
	syncSessionIndex(getDb(), intConv, 'entity', intId, row.status, entityIndexText(row));
	appendSessionMemoryLog(getDb(), intConv, {
		eventKind: row.status === 'deleted' ? 'entity.delete' : 'entity.update',
		itemType: 'entity',
		itemId: intId,
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
	conversationId: string | number,
	opts: { fromKeyOrId: string; intoKeyOrId: string }
): MergeEntitiesResult {
	const db = getDb();
	const intConv = convInt(conversationId);
	const tx = db.transaction((): MergeEntitiesResult => {
		const from = getEntity(intConv, opts.fromKeyOrId);
		const into = getEntity(intConv, opts.intoKeyOrId);
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
		const fromId = memoryEntityId.parse(from.id);
		const intoId = memoryEntityId.parse(into.id);
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
			.all(intConv, fromId) as FactRow[];
		for (const factRow of factRows) {
			db.prepare(
				'UPDATE memory_facts SET entity_id = ?, updated_at = ? WHERE id = ? AND conversation_id = ?'
			).run(intoId, now, factRow.id, intConv);
			const updated = db
				.prepare('SELECT * FROM memory_facts WHERE id = ?')
				.get(factRow.id) as FactRow;
			syncSessionIndex(db, intConv, 'fact', updated.id, updated.status, factIndexText(updated));
			appendSessionMemoryLog(db, intConv, {
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
			consolidateFactGroup(db, intConv, intoId, predicate);
			consolidateFactGroup(db, intConv, fromId, predicate);
		}

		const eventRows = db
			.prepare(
				`SELECT * FROM memory_events
				  WHERE conversation_id = ? AND (actor_entity_id = ? OR target_entity_id = ?)`
			)
			.all(intConv, fromId, fromId) as EventRow[];
		for (const eventRow of eventRows) {
			const nextActor = eventRow.actor_entity_id === fromId ? intoId : eventRow.actor_entity_id;
			const nextTarget = eventRow.target_entity_id === fromId ? intoId : eventRow.target_entity_id;
			db.prepare(
				'UPDATE memory_events SET actor_entity_id = ?, target_entity_id = ? WHERE id = ? AND conversation_id = ?'
			).run(nextActor, nextTarget, eventRow.id, intConv);
			const updated = db
				.prepare('SELECT * FROM memory_events WHERE id = ?')
				.get(eventRow.id) as EventRow;
			indexItem(db, intConv, 'event', updated.id, eventIndexText(updated));
			appendSessionMemoryLog(db, intConv, {
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
			.all(intConv) as OpenLoopRow[];
		for (const loopRow of loopRows) {
			const related = parseJson(loopRow.related_entity_ids_json, []) as number[];
			if (!related.includes(fromId)) continue;
			const next = related.map((id) => (id === fromId ? intoId : id));
			const deduped = [...new Set(next)];
			updateOpenLoop(intConv, loopRow.id, { relatedEntityIds: deduped });
		}

		const tombstoned = updateEntity(intConv, fromId, { status: 'deleted' });
		addEvent(intConv, {
			eventType: 'memory_entities_merged',
			summary: `Merged ${from.entityKey} into ${into.entityKey}.`,
			payload: {
				fromEntityId: fromId,
				fromEntityKey: from.entityKey,
				intoEntityId: intoId,
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
