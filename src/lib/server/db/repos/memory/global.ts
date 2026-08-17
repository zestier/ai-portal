import type Database from "better-sqlite3";
import { getDb } from "../../index";
import {
  convInt,
  msgIntOf,
  rowToGlobalMemory,
  safeJson,
  type GlobalMemory,
  type GlobalMemoryRow,
} from "./rows";
import { ftsQuery } from "./search";

function indexGlobalMemory(
  db: Database.Database,
  userId: number,
  itemId: number,
  text: string,
) {
  db.prepare(
    "DELETE FROM global_memory_search_index WHERE user_id = ? AND item_id = ?",
  ).run(userId, itemId);
  db.prepare(
    `INSERT INTO global_memory_search_index(user_id, item_id, text)
		 VALUES (?, ?, ?)`,
  ).run(userId, itemId, text);
}

function deleteGlobalIndex(
  db: Database.Database,
  userId: number,
  itemId: number,
) {
  db.prepare(
    "DELETE FROM global_memory_search_index WHERE user_id = ? AND item_id = ?",
  ).run(userId, itemId);
}

function globalMemoryIndexText(row: GlobalMemoryRow): string {
  return [row.kind, row.memory_key, row.value_json].join("\n");
}

export function upsertGlobalMemory(
  userId: number,
  input: {
    kind: string;
    memoryKey: string;
    value: unknown;
    sourceConversationId?: string | number | null | undefined;
    sourceMessageId?: string | number | null | undefined;
  },
): GlobalMemory {
  const db = getDb();
  const now = Date.now();
  // Keep the SELECT and the dependent INSERT/UPDATE in the SAME transaction so
  // the read-modify-write is atomic. With the synchronous single-process
  // better-sqlite3 connection (a per-process singleton) each transaction runs
  // to completion before the next begins, so no other caller can slip an
  // INSERT for the same (user_id, kind, memory_key) between our SELECT and
  // write — which would otherwise violate the UNIQUE constraint. It also keeps
  // the projection write and the FTS index write crash-atomic.
  const tx = db.transaction((): GlobalMemory => {
    const existing = db
      .prepare(
        `SELECT * FROM global_memories
			  WHERE user_id = ? AND kind = ? AND memory_key = ?`,
      )
      .get(userId, input.kind, input.memoryKey) as GlobalMemoryRow | undefined;
    if (existing) {
      db.prepare(
        `UPDATE global_memories
			    SET value_json = ?, status = 'active', source_conversation_id = ?,
			        source_message_id = ?, updated_at = ?
			  WHERE id = ?`,
      ).run(
        safeJson(input.value),
        input.sourceConversationId == null
          ? existing.source_conversation_id
          : convInt(input.sourceConversationId),
        input.sourceMessageId == null
          ? existing.source_message_id
          : msgIntOf(input.sourceMessageId),
        now,
        existing.id,
      );
      const updated = db
        .prepare("SELECT * FROM global_memories WHERE id = ?")
        .get(existing.id) as GlobalMemoryRow;
      indexGlobalMemory(db, userId, updated.id, globalMemoryIndexText(updated));
      return rowToGlobalMemory(updated);
    }
    const info = db
      .prepare(
        `INSERT INTO global_memories(
		   user_id, kind, memory_key, value_json, status, source_conversation_id,
		   source_message_id, created_at, updated_at
		 ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(
        userId,
        input.kind,
        input.memoryKey,
        safeJson(input.value),
        input.sourceConversationId == null
          ? null
          : convInt(input.sourceConversationId),
        input.sourceMessageId == null ? null : msgIntOf(input.sourceMessageId),
        now,
        now,
      );
    const id = Number(info.lastInsertRowid);
    const row = db
      .prepare("SELECT * FROM global_memories WHERE id = ?")
      .get(id) as GlobalMemoryRow;
    indexGlobalMemory(db, userId, id, globalMemoryIndexText(row));
    return rowToGlobalMemory(row);
  });
  return tx();
}

export type UpdateGlobalMemoryResult =
  | { status: "updated"; memory: GlobalMemory }
  | { status: "not_found" }
  | { status: "conflict" };

export function updateGlobalMemory(
  userId: number,
  id: number,
  input: {
    kind: string;
    memoryKey: string;
    value: unknown;
    sourceConversationId?: number | null | undefined;
    sourceMessageId?: number | null | undefined;
  },
): UpdateGlobalMemoryResult {
  const db = getDb();
  // Keep the conflict check, the UPDATE, and the FTS index write in the SAME
  // transaction so they are atomic. With the synchronous single-process
  // better-sqlite3 connection each transaction runs to completion before the
  // next, so no other caller can create or rename a row into the same
  // (user_id, kind, memory_key) between our check and our UPDATE (which would
  // invalidate the conflict check or abort our commit on the UNIQUE
  // constraint), and the projection/FTS writes stay crash-atomic.
  const tx = db.transaction((): UpdateGlobalMemoryResult => {
    const current = db
      .prepare("SELECT * FROM global_memories WHERE id = ? AND user_id = ?")
      .get(id, userId) as GlobalMemoryRow | undefined;
    if (!current) return { status: "not_found" };
    const conflict = db
      .prepare(
        `SELECT id FROM global_memories
			  WHERE user_id = ? AND kind = ? AND memory_key = ? AND id != ?`,
      )
      .get(userId, input.kind, input.memoryKey, id) as
      { id: number } | undefined;
    if (conflict) return { status: "conflict" };
    const now = Date.now();
    db.prepare(
      `UPDATE global_memories
		    SET kind = ?, memory_key = ?, value_json = ?, status = 'active',
		        source_conversation_id = ?, source_message_id = ?, updated_at = ?
		  WHERE id = ? AND user_id = ?`,
    ).run(
      input.kind,
      input.memoryKey,
      safeJson(input.value),
      input.sourceConversationId == null
        ? current.source_conversation_id
        : convInt(input.sourceConversationId),
      input.sourceMessageId == null
        ? current.source_message_id
        : msgIntOf(input.sourceMessageId),
      now,
      id,
      userId,
    );
    const updated = db
      .prepare("SELECT * FROM global_memories WHERE id = ? AND user_id = ?")
      .get(id, userId) as GlobalMemoryRow;
    indexGlobalMemory(db, userId, updated.id, globalMemoryIndexText(updated));
    return { status: "updated", memory: rowToGlobalMemory(updated) };
  });
  return tx();
}

export function listGlobalMemories(
  userId: number,
  opts: { kind?: string; status?: string; limit?: number } = {},
): GlobalMemory[] {
  const status = opts.status ?? "active";
  const rows = opts.kind
    ? (getDb()
        .prepare(
          `SELECT * FROM global_memories
					  WHERE user_id = ? AND kind = ? AND status = ?
					  ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(userId, opts.kind, status, opts.limit ?? 100) as GlobalMemoryRow[])
    : (getDb()
        .prepare(
          `SELECT * FROM global_memories
					  WHERE user_id = ? AND status = ?
					  ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(userId, status, opts.limit ?? 100) as GlobalMemoryRow[]);
  return rows.map(rowToGlobalMemory);
}

export function searchGlobalMemories(
  userId: number,
  opts: { query: string; limit?: number },
): Array<{ itemId: number; text: string }> {
  const query = opts.query.trim();
  if (!query) return [];
  const rows = getDb()
    .prepare(
      `SELECT item_id, text
			   FROM global_memory_search_index
			  WHERE user_id = ?
			    AND global_memory_search_index MATCH ?
			  ORDER BY rank
			  LIMIT ?`,
    )
    .all(userId, ftsQuery(query), opts.limit ?? 20) as {
    item_id: number;
    text: string;
  }[];
  return rows.map((row) => ({ itemId: row.item_id, text: row.text }));
}

export function deleteGlobalMemory(userId: number, id: number): boolean {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE global_memories
			    SET status = 'deleted', updated_at = ?
			  WHERE id = ? AND user_id = ?`,
    )
    .run(Date.now(), id, userId);
  if (result.changes > 0) {
    deleteGlobalIndex(db, userId, id);
  }
  return result.changes > 0;
}
