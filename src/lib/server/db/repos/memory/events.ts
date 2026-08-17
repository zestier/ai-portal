import { getDb } from "../../index";
import { memoryEntityId } from "$lib/ids";
import { appendSessionMemoryLog } from "./common";
import {
  convInt,
  resolveId,
  rowToEvent,
  safeJson,
  type AddEventInput,
  type EventRow,
  type MemoryEvent,
} from "./rows";
import { eventIndexText, indexItem } from "./search";

export function addEvent(
  conversationId: string | number,
  input: AddEventInput,
): MemoryEvent {
  const db = getDb();
  const intConv = convInt(conversationId);
  const now = Date.now();
  // The projection INSERT, the FTS index write, and the event-log append must
  // commit atomically: the event log is the rebuild source of truth, so a crash
  // between these writes would either lose the log entry (unrecoverable) or
  // diverge the FTS index from the projection row. Wrap all three in one tx.
  const tx = db.transaction((): MemoryEvent => {
    const info = db
      .prepare(
        `INSERT INTO memory_events(
			   conversation_id, turn_id, event_type, occurred_at, actor_entity_id,
			   target_entity_id, summary, payload_json, visibility, confidence,
			   source_message_id, source_tool_call_id, created_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        intConv,
        input.turnId ?? null,
        input.eventType,
        now,
        resolveId(input.actorEntityId, memoryEntityId),
        resolveId(input.targetEntityId, memoryEntityId),
        input.summary,
        safeJson(input.payload ?? {}),
        input.visibility ?? "session",
        input.confidence ?? 1,
        input.sourceMessageId ?? null,
        now,
      );
    const id = Number(info.lastInsertRowid);
    const row = db
      .prepare("SELECT * FROM memory_events WHERE id = ?")
      .get(id) as EventRow;
    indexItem(db, intConv, "event", id, eventIndexText(row));
    appendSessionMemoryLog(db, intConv, {
      eventKind: "event.create",
      itemType: "event",
      itemId: id,
      sourceMessageId: input.sourceMessageId ?? null,
      turnId: input.turnId ?? null,
      payload: { item: rowToEvent(row) },
    });
    return rowToEvent(row);
  });
  return tx();
}

/**
 * Find an existing event sharing this concurrent-dedupe key — the natural
 * identity of an extracted event: the turn it belongs to, its type, and its
 * summary text. `addEvent` is unconditionally append-only, so two extractions
 * racing on the same conversation (each working from the same pre-commit
 * snapshot) would otherwise both insert the identical event. commitPatch
 * consults this before inserting and skips the write when a match exists.
 *
 * turn_id participates with NULL-safe equality so two turn-less events with the
 * same type+summary still collapse, while events from different turns stay
 * distinct.
 */
export function findDuplicateEvent(
  conversationId: number,
  key: { turnId: string | null; eventType: string; summary: string },
): MemoryEvent | null {
  const turnId = key.turnId ?? null;
  const row = getDb()
    .prepare(
      `SELECT * FROM memory_events
			  WHERE conversation_id = ?
			    AND event_type = ?
			    AND summary = ?
			    AND ((turn_id IS NULL AND ? IS NULL) OR turn_id = ?)
			  ORDER BY created_at ASC LIMIT 1`,
    )
    .get(conversationId, key.eventType, key.summary, turnId, turnId) as
    EventRow | undefined;
  return row ? rowToEvent(row) : null;
}

export function listEvents(
  conversationId: string | number,
  opts: {
    limit?: number | undefined;
    entityId?: string | number | undefined;
    eventType?: string | undefined;
  } = {},
): MemoryEvent[] {
  const intConv = convInt(conversationId);
  const limit = opts.limit ?? 50;
  let rows: EventRow[];
  const entityId = resolveId(opts.entityId, memoryEntityId);
  if (entityId) {
    rows = getDb()
      .prepare(
        `SELECT * FROM memory_events
				  WHERE conversation_id = ? AND (actor_entity_id = ? OR target_entity_id = ?)
				  ORDER BY created_at DESC LIMIT ?`,
      )
      .all(intConv, entityId, entityId, limit) as EventRow[];
  } else if (opts.eventType) {
    rows = getDb()
      .prepare(
        `SELECT * FROM memory_events
				  WHERE conversation_id = ? AND event_type = ?
				  ORDER BY created_at DESC LIMIT ?`,
      )
      .all(intConv, opts.eventType, limit) as EventRow[];
  } else {
    rows = getDb()
      .prepare(
        `SELECT * FROM memory_events
				  WHERE conversation_id = ?
				  ORDER BY created_at DESC LIMIT ?`,
      )
      .all(intConv, limit) as EventRow[];
  }
  return rows.map(rowToEvent);
}
