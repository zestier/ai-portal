import { getDb } from "../../index";
import { memoryEntityId, memoryFactId } from "$lib/ids";
import { appendSessionMemoryLog, consolidateFactGroup } from "./common";
import {
  convInt,
  resolveId,
  rowToFact,
  safeJson,
  type AddFactInput,
  type FactRow,
  type MemoryFact,
} from "./rows";
import { factIndexText, indexItem, syncSessionIndex } from "./search";

export function addFact(
  conversationId: string | number,
  input: AddFactInput,
): MemoryFact {
  const db = getDb();
  const intConv = convInt(conversationId);
  const tx = db.transaction(() => {
    const now = Date.now();
    // Append the raw observation as a `fact.create` event + projection row.
    // Supersession and dedupe are NOT decided here; they are derived from the
    // event stream by consolidateFactGroup (below), which is replayed on every
    // projection rebuild. That keeps a rebuild correct "for free": rebuilding
    // from the surviving observations re-derives the active set.
    const info = db
      .prepare(
        `INSERT INTO memory_facts(
			   conversation_id, entity_id, predicate, value_json, status, visibility,
			   confidence, source_event_id, source_message_id, supersedes_fact_id,
			   pinned, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        intConv,
        resolveId(input.entityId, memoryEntityId),
        input.predicate,
        safeJson(input.value),
        input.visibility ?? "session",
        input.confidence ?? 1,
        input.sourceEventId ?? null,
        input.sourceMessageId ?? null,
        input.supersedesFactId ?? null,
        input.pinned ? 1 : 0,
        now,
        now,
      );
    const id = Number(info.lastInsertRowid);
    const row = db
      .prepare("SELECT * FROM memory_facts WHERE id = ?")
      .get(id) as FactRow;
    indexItem(db, intConv, "fact", id, factIndexText(row));
    appendSessionMemoryLog(db, intConv, {
      eventKind: "fact.create",
      itemType: "fact",
      itemId: id,
      sourceMessageId: input.sourceMessageId ?? null,
      payload: { item: rowToFact(row) },
    });
    consolidateFactGroup(db, intConv, row.entity_id, row.predicate);
    return db
      .prepare("SELECT * FROM memory_facts WHERE id = ?")
      .get(id) as FactRow;
  });
  return rowToFact(tx());
}

export function listFacts(
  conversationId: string | number,
  opts: {
    limit?: number | undefined;
    entityId?: string | number | undefined;
    status?: string | undefined;
    predicate?: string | undefined;
  } = {},
): MemoryFact[] {
  const intConv = convInt(conversationId);
  const limit = opts.limit ?? 100;
  const status = opts.status ?? "active";
  const clauses = ["conversation_id = ?", "status = ?"];
  const params: (string | number)[] = [intConv, status];
  const entityId = resolveId(opts.entityId, memoryEntityId);
  if (entityId) {
    clauses.push("entity_id = ?");
    params.push(entityId);
  }
  if (opts.predicate) {
    clauses.push("predicate = ?");
    params.push(opts.predicate);
  }
  params.push(limit);
  const rows = getDb()
    .prepare(
      `SELECT * FROM memory_facts
			  WHERE ${clauses.join(" AND ")}
			  ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...params) as FactRow[];
  return rows.map(rowToFact);
}

/**
 * Fetch a single fact by id (any status), or null if it doesn't exist in this
 * conversation. Used by the forget path to resolve a packet `[id=...]` handle to
 * a concrete fact and check its current status/kind before tombstoning it.
 */
export function getFact(
  conversationId: string | number,
  id: string | number,
): MemoryFact | null {
  const intConv = convInt(conversationId);
  const intId = resolveId(id, memoryFactId);
  if (!intId) return null;
  const row = getDb()
    .prepare("SELECT * FROM memory_facts WHERE id = ? AND conversation_id = ?")
    .get(intId, intConv) as FactRow | undefined;
  return row ? rowToFact(row) : null;
}

export function updateFact(
  conversationId: string | number,
  id: string | number,
  patch: Partial<
    Pick<
      MemoryFact,
      "predicate" | "value" | "status" | "visibility" | "confidence"
    >
  >,
): MemoryFact | null {
  const db = getDb();
  const intConv = convInt(conversationId);
  const tx = db.transaction(() => {
    const intId = resolveId(id, memoryFactId);
    if (!intId) return null;
    const current = db
      .prepare(
        "SELECT * FROM memory_facts WHERE id = ? AND conversation_id = ?",
      )
      .get(intId, intConv) as FactRow | undefined;
    if (!current) return null;
    db.prepare(
      `UPDATE memory_facts
			    SET predicate = ?, value_json = ?, status = ?, visibility = ?, confidence = ?, updated_at = ?
			  WHERE id = ? AND conversation_id = ?`,
    ).run(
      patch.predicate ?? current.predicate,
      patch.value === undefined ? current.value_json : safeJson(patch.value),
      patch.status ?? current.status,
      patch.visibility ?? current.visibility,
      patch.confidence ?? current.confidence,
      Date.now(),
      intId,
      intConv,
    );
    const row = db
      .prepare(
        "SELECT * FROM memory_facts WHERE id = ? AND conversation_id = ?",
      )
      .get(intId, intConv) as FactRow;
    syncSessionIndex(
      db,
      intConv,
      "fact",
      intId,
      row.status,
      factIndexText(row),
    );
    appendSessionMemoryLog(db, intConv, {
      eventKind:
        row.status === "deleted"
          ? "fact.delete"
          : row.status === "superseded"
            ? "fact.supersede"
            : "fact.update",
      itemType: "fact",
      itemId: intId,
      payload: { item: rowToFact(row) },
    });
    // Re-derive the active set: deleting/editing a fact can promote a previously
    // superseded sibling (e.g. dropping the observation that overrode it).
    consolidateFactGroup(db, intConv, row.entity_id, row.predicate);
    return rowToFact(
      db
        .prepare("SELECT * FROM memory_facts WHERE id = ?")
        .get(intId) as FactRow,
    );
  });
  return tx();
}
