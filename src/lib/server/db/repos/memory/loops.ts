import type Database from "better-sqlite3";
import { getDb } from "../../index";
import { memoryEntityId } from "$lib/ids";
import {
  appendSessionMemoryLog,
  applyOpenLoopLivenessProjection,
} from "./common";
import {
  convInt,
  msgIntOf,
  resolveId,
  rowToOpenLoop,
  safeJson,
  type AddOpenLoopInput,
  type MemoryOpenLoop,
  type OpenLoopRow,
} from "./rows";
import { indexItem, openLoopIndexText, syncSessionIndex } from "./search";

/**
 * Derive a stable, legible loop key from its title (e.g. "Find the attic key"
 * -> `loop.find_the_attic_key`). The result is namespaced like an entityKey so
 * the model treats it as the same kind of handle.
 */
function slugifyLoopKey(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return `loop.${base || "thread"}`;
}

/**
 * Allocate a conversation-unique loop key, suffixing `_2`, `_3`, ... on
 * collision. Generated once at creation and persisted in the create event, so
 * replay restores it rather than regenerating (keeping event-sourcing faithful).
 */
function allocateLoopKey(
  db: Database.Database,
  conversationId: number,
  title: string,
): string {
  const base = slugifyLoopKey(title);
  const taken = db.prepare(
    "SELECT 1 FROM memory_open_loops WHERE conversation_id = ? AND loop_key = ?",
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
export function resolveOpenLoopId(
  conversationId: string | number,
  ref: string | number,
): number | null {
  if (ref === "" || ref === undefined || ref === null) return null;
  const intConv = convInt(conversationId);
  const db = getDb();
  const byId = db
    .prepare(
      "SELECT id FROM memory_open_loops WHERE id = ? AND conversation_id = ?",
    )
    .get(ref, intConv) as { id: number } | undefined;
  if (byId) return byId.id;
  const byKey = db
    .prepare(
      "SELECT id FROM memory_open_loops WHERE loop_key = ? AND conversation_id = ? AND loop_key != ''",
    )
    .get(ref, intConv) as { id: number } | undefined;
  return byKey ? byKey.id : null;
}

/**
 * True when an error is the UNIQUE(conversation_id, loop_key) violation guarded
 * by idx_memory_open_loops_conv_key (migration 057). better-sqlite3 surfaces
 * these as a SqliteError with code 'SQLITE_CONSTRAINT_UNIQUE'.
 */
function isLoopKeyUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return (
    !!e &&
    e.code === "SQLITE_CONSTRAINT_UNIQUE" &&
    typeof e.message === "string" &&
    e.message.includes("memory_open_loops.loop_key")
  );
}

export function addOpenLoop(
  conversationId: string | number,
  input: AddOpenLoopInput,
): MemoryOpenLoop {
  const db = getDb();
  const intConv = convInt(conversationId);
  const now = Date.now();
  // allocateLoopKey reads-then-inserts, so two concurrent extractions (separate
  // connections, same pre-commit snapshot) can both pick the same free key. The
  // UNIQUE index now rejects the loser's INSERT instead of letting it corrupt
  // key-based addressing; re-run the whole transaction so the loser re-reads
  // the now-taken key and allocates the next suffix. Bounded so a genuinely
  // unrelated constraint failure can't spin forever.
  const maxAttempts = 5;
  for (let attempt = 1; ; attempt++) {
    // Key allocation, the projection INSERT, the FTS index write, and the
    // event-log append must commit atomically: the event log is the rebuild
    // source of truth, so a crash between these writes would either lose the
    // log entry (unrecoverable) or diverge the FTS index from the projection
    // row.
    const tx = db.transaction((): MemoryOpenLoop => {
      const loopKey = allocateLoopKey(db, intConv, input.title);
      const info = db
        .prepare(
          `INSERT INTO memory_open_loops(
				   conversation_id, loop_key, loop_type, title, description, status, priority,
				   related_entity_ids_json, source_event_id, source_message_id, created_at, updated_at
				 ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          intConv,
          loopKey,
          input.loopType,
          input.title,
          input.description ?? "",
          input.priority ?? 0,
          safeJson(
            (input.relatedEntityIds ?? [])
              .map((id) => resolveId(id, memoryEntityId))
              .filter((id): id is number => id !== null && id > 0),
          ),
          input.sourceEventId ?? null,
          input.sourceMessageId ?? null,
          now,
          now,
        );
      const id = Number(info.lastInsertRowid);
      const row = db
        .prepare("SELECT * FROM memory_open_loops WHERE id = ?")
        .get(id) as OpenLoopRow;
      indexItem(db, intConv, "open_loop", id, openLoopIndexText(row));
      appendSessionMemoryLog(db, intConv, {
        eventKind: "open_loop.create",
        itemType: "open_loop",
        itemId: id,
        sourceMessageId: input.sourceMessageId ?? null,
        payload: { item: rowToOpenLoop(row) },
      });
      return rowToOpenLoop(row);
    });
    try {
      return tx();
    } catch (err) {
      if (attempt < maxAttempts && isLoopKeyUniqueViolation(err)) continue;
      throw err;
    }
  }
}

/**
 * Find an existing OPEN loop sharing this concurrent-dedupe key — loop type +
 * title. `addOpenLoop` is unconditionally append-only, so two extractions
 * racing on the same conversation (each from the same pre-commit snapshot)
 * would otherwise both insert the identical loop. commitPatch consults this
 * before inserting and skips the write when a still-open match exists. Only
 * `open` loops match so a loop legitimately re-raised after being resolved or
 * dropped is not silently suppressed.
 */
export function findDuplicateOpenLoop(
  conversationId: number,
  key: { loopType: string; title: string },
): MemoryOpenLoop | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM memory_open_loops
			  WHERE conversation_id = ? AND loop_type = ? AND title = ? AND status = 'open'
			  ORDER BY created_at ASC LIMIT 1`,
    )
    .get(conversationId, key.loopType, key.title) as OpenLoopRow | undefined;
  return row ? rowToOpenLoop(row) : null;
}

export function getOpenLoop(
  conversationId: string | number,
  id: number,
): MemoryOpenLoop | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM memory_open_loops WHERE id = ? AND conversation_id = ?",
    )
    .get(id, convInt(conversationId)) as OpenLoopRow | undefined;
  return row ? rowToOpenLoop(row) : null;
}

export function listOpenLoops(
  conversationId: string | number,
  opts: {
    limit?: number | undefined;
    status?: string | undefined;
    loopType?: string | undefined;
  } = {},
): MemoryOpenLoop[] {
  const intConv = convInt(conversationId);
  const limit = opts.limit ?? 50;
  const status = opts.status ?? "open";
  if (status === "all") {
    const rows = opts.loopType
      ? (getDb()
          .prepare(
            `SELECT * FROM memory_open_loops
						  WHERE conversation_id = ? AND loop_type = ?
						  ORDER BY priority DESC, updated_at DESC LIMIT ?`,
          )
          .all(intConv, opts.loopType, limit) as OpenLoopRow[])
      : (getDb()
          .prepare(
            `SELECT * FROM memory_open_loops
						  WHERE conversation_id = ?
						  ORDER BY priority DESC, updated_at DESC LIMIT ?`,
          )
          .all(intConv, limit) as OpenLoopRow[]);
    return rows.map(rowToOpenLoop);
  }
  const rows = opts.loopType
    ? (getDb()
        .prepare(
          `SELECT * FROM memory_open_loops
					  WHERE conversation_id = ? AND loop_type = ? AND status = ?
					  ORDER BY priority DESC, updated_at DESC LIMIT ?`,
        )
        .all(intConv, opts.loopType, status, limit) as OpenLoopRow[])
    : (getDb()
        .prepare(
          `SELECT * FROM memory_open_loops
					  WHERE conversation_id = ? AND status = ?
					  ORDER BY priority DESC, updated_at DESC LIMIT ?`,
        )
        .all(intConv, status, limit) as OpenLoopRow[]);
  return rows.map(rowToOpenLoop);
}

export function updateOpenLoop(
  conversationId: number,
  id: number,
  patch: Partial<
    Pick<
      MemoryOpenLoop,
      "loopType" | "title" | "description" | "status" | "priority"
    >
  > & { relatedEntityIds?: Array<string | number> | undefined },
): MemoryOpenLoop | null {
  const current = getDb()
    .prepare(
      "SELECT * FROM memory_open_loops WHERE id = ? AND conversation_id = ?",
    )
    .get(id, conversationId) as OpenLoopRow | undefined;
  if (!current) return null;
  getDb()
    .prepare(
      `UPDATE memory_open_loops
			    SET loop_type = ?, title = ?, description = ?, status = ?, priority = ?,
			        related_entity_ids_json = ?, updated_at = ?
			  WHERE id = ? AND conversation_id = ?`,
    )
    .run(
      patch.loopType ?? current.loop_type,
      patch.title ?? current.title,
      patch.description ?? current.description,
      patch.status ?? current.status,
      patch.priority ?? current.priority,
      patch.relatedEntityIds === undefined
        ? current.related_entity_ids_json
        : safeJson(
            patch.relatedEntityIds
              .map((entityRef) => resolveId(entityRef, memoryEntityId))
              .filter(
                (entityId): entityId is number =>
                  entityId !== null && entityId > 0,
              ),
          ),
      Date.now(),
      id,
      conversationId,
    );
  const row = getDb()
    .prepare(
      "SELECT * FROM memory_open_loops WHERE id = ? AND conversation_id = ?",
    )
    .get(id, conversationId) as OpenLoopRow;
  syncSessionIndex(
    getDb(),
    conversationId,
    "open_loop",
    id,
    row.status,
    openLoopIndexText(row),
  );
  appendSessionMemoryLog(getDb(), conversationId, {
    eventKind:
      row.status === "deleted" ? "open_loop.delete" : "open_loop.update",
    itemType: "open_loop",
    itemId: id,
    payload: { item: rowToOpenLoop(row) },
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
  conversationId: number,
  input: {
    presentedLoopIds: number[];
    keptLoopIds?: number[] | undefined;
    baseThreshold: number;
    sourceMessageId?: string | number | null | undefined;
    turnId?: string | null | undefined;
  },
): { dropped: number[] } {
  const presented = [...new Set(input.presentedLoopIds)].filter(Boolean);
  if (presented.length === 0 || !(input.baseThreshold > 0))
    return { dropped: [] };
  const kept = [...new Set(input.keptLoopIds ?? [])].filter(Boolean);
  const payload = { presented, kept, baseThreshold: input.baseThreshold };
  const intSource = msgIntOf(input.sourceMessageId);
  const db = getDb();
  let dropped: number[] = [];
  const tx = db.transaction(() => {
    // Mutate the live projection directly (mirroring addOpenLoop et al.,
    // which upsert then log), then append the event so a later rebuild
    // re-derives the same result.
    dropped = applyOpenLoopLivenessProjection(db, conversationId, payload);
    appendSessionMemoryLog(db, conversationId, {
      eventKind: "open_loop.liveness",
      itemType: "open_loop_liveness",
      itemId: Date.now(),
      sourceMessageId: intSource,
      turnId: input.turnId ?? null,
      payload,
    });
  });
  tx();
  return { dropped };
}
