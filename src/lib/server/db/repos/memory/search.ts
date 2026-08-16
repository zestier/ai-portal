import type Database from 'better-sqlite3';
import { memoryEntityId, memoryFactId } from '$lib/ids';
import { getDb } from '../../index';
import { convInt, type EntityRow, type EventRow, type FactRow, type OpenLoopRow } from './rows';

export function ftsQuery(query: string): string {
	return query
		.split(/\s+/)
		.map((part) => part.replace(/"/g, ''))
		.filter(Boolean)
		.map((part) => `"${part}"`)
		.join(' OR ');
}

export function indexItem(
	db: Database.Database,
	conversationId: number,
	itemType: string,
	itemId: number,
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

export function syncSessionIndex(
	db: Database.Database,
	conversationId: number,
	itemType: string,
	itemId: number,
	status: string,
	text: string
) {
	if (shouldIndexSessionItem(itemType, status)) {
		indexItem(db, conversationId, itemType, itemId, text);
	} else {
		deleteSessionIndex(db, conversationId, itemType, itemId);
	}
}

export function shouldIndexSessionItem(itemType: string, status: string): boolean {
	return itemType === 'open_loop' ? status === 'open' : status === 'active';
}

export function deleteSessionIndex(
	db: Database.Database,
	conversationId: number,
	itemType: string,
	itemId: number
) {
	db.prepare(
		'DELETE FROM memory_search_index WHERE conversation_id = ? AND item_type = ? AND item_id = ?'
	).run(conversationId, itemType, itemId);
}

export function entityIndexText(row: EntityRow): string {
	return [row.entity_key, row.entity_type, row.display_name, row.summary, row.metadata_json].join(
		'\n'
	);
}

export function eventIndexText(row: EventRow): string {
	return [row.event_type, row.summary, row.payload_json].join('\n');
}

export function factIndexText(row: FactRow): string {
	return [row.predicate, row.value_json].join('\n');
}

export function openLoopIndexText(row: OpenLoopRow): string {
	return [row.loop_key, row.loop_type, row.title, row.description].join('\n');
}

export function search(
	conversationId: string | number,
	opts: { query: string; types?: string[] | undefined; limit?: number | undefined }
): Array<{
	itemType: string;
	itemId: string | number;
	text: string;
	score?: number;
	sources?: string[];
}> {
	const query = opts.query.trim();
	if (!query) return [];
	const limit = opts.limit ?? 20;
	const types = opts.types ?? [];
	const intConv = convInt(conversationId);
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
		.all(intConv, ftsQuery(query), ...types, limit) as {
		item_type: string;
		item_id: number;
		text: string;
	}[];
	return rows.map((row, index) => ({
		itemType: row.item_type,
		// Entity/fact hits reference prefixed entities — surface their handles so
		// callers can correlate with `MemoryEntity.id` / `MemoryFact.id`.
		itemId:
			row.item_type === 'entity'
				? memoryEntityId.encode(row.item_id)
				: row.item_type === 'fact'
					? memoryFactId.encode(row.item_id)
					: row.item_id,
		text: row.text,
		score: limit - index,
		sources: ['fts']
	}));
}

/**
 * Purge the FTS5 search-index rows for a conversation's session memory.
 *
 * `memory_search_index` is an FTS5 virtual table, which SQLite forbids as the
 * target of a foreign key. So the `ON DELETE CASCADE` that cleans the relational
 * `memory_*` tables when a conversation row is deleted does NOT reach this index
 * — its rows would leak forever. Any path that deletes a conversation must call
 * this in the SAME transaction as the delete (see `conversations.remove`). Pass
 * the active db handle so the purge participates in the caller's transaction.
 */
export function purgeSessionSearchIndex(db: Database.Database, conversationId: number): void {
	db.prepare('DELETE FROM memory_search_index WHERE conversation_id = ?').run(conversationId);
}
