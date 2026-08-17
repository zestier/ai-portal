import type Database from "better-sqlite3";
import { getDb } from "../../index";
// Aliased: repo functions take params named `conversationId`/`toolCallId`, which
// would shadow the codec imports.
import {
  conversationId as convCodec,
  messageId as msgCodec,
  toolCallId as toolCodec,
} from "$lib/ids";
import type { Message, MessageStatus, Role } from "$lib/types";

export { convCodec, msgCodec, toolCodec };

export interface MsgRow {
  id: number;
  conversation_id: number;
  role: string;
  content: string;
  status: string;
  error_code: string | null;
  created_at: number;
  reasoning: string | null;
  reasoning_duration_ms: number | null;
}

export interface ToolRow {
  id: number;
  message_id: number;
  tool: string;
  args_json: string | null;
  result_json: string | null;
  args_bytes?: number;
  result_bytes?: number;
  status: string;
  started_at: number;
  ended_at: number | null;
  text_offset: number | null;
  parent_tool_call_id: number | null;
}

export interface BackgroundAgentLifecycleRow {
  tool_call_id: number;
  agent_id: string;
  status: "running" | "completed" | "failed";
  started_at: number;
  ended_at: number | null;
}

export interface EditRow {
  id: number;
  message_id: number;
  path: string;
  diff: string | null;
  diff_bytes?: number;
  created_at: number;
  text_offset: number | null;
  parent_tool_call_id: number | null;
}

export interface ReasoningRow {
  id: number;
  message_id: number;
  segment_index: number;
  text: string | null;
  text_bytes?: number;
  kind: string;
  text_offset: number | null;
  started_at: number;
  duration_ms: number | null;
  parent_tool_call_id: number | null;
}

// SQLite is built with a cap on bound parameters per statement
// (`SQLITE_MAX_VARIABLE_NUMBER`, often 999 in bundled builds). Conversations
// can accumulate more message / tool-call ids than that, so any `IN (?, ...)`
// list built from such an array has to be split into batches well under the
// limit to avoid `SQLITE_RANGE`.
const ID_BATCH_SIZE = 500;

function batchIds<T>(ids: readonly T[], size = ID_BATCH_SIZE): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    batches.push(ids.slice(i, i + size));
  }
  return batches;
}

// Runs a `SELECT ... IN (<placeholders>) ...` statement once per id batch and
// concatenates the rows. `buildSql` receives the comma-separated placeholder
// list for the current batch; `leadingParams` are bound ahead of the id list
// (any `?` the projection itself uses). Rows whose grouping key lives entirely
// within a single batch (e.g. all tool_calls for a given message_id) keep their
// relative order, since each id appears in exactly one batch.
export function selectInBatches<R>(
  db: Database.Database,
  ids: readonly number[],
  buildSql: (placeholders: string) => string,
  leadingParams: readonly (string | number)[] = [],
): R[] {
  const rows: R[] = [];
  for (const batch of batchIds(ids)) {
    const placeholders = batch.map(() => "?").join(",");
    // Append element-by-element rather than spreading: a batch is capped at
    // 500 ids, but the rows it returns are not, and `push(...rows)` would hit
    // the JS argument limit for very large result sets.
    for (const row of db
      .prepare(buildSql(placeholders))
      .all(...leadingParams, ...batch) as R[]) {
      rows.push(row);
    }
  }
  return rows;
}

export function runInBatches(
  db: Database.Database,
  ids: readonly number[],
  buildSql: (placeholders: string) => string,
): void {
  for (const batch of batchIds(ids)) {
    const placeholders = batch.map(() => "?").join(",");
    db.prepare(buildSql(placeholders)).run(...batch);
  }
}

export function rowToMessage(r: MsgRow): Message {
  return {
    id: msgCodec.encode(r.id),
    conversationId: convCodec.encode(r.conversation_id),
    role: r.role as Role,
    content: r.content,
    status: r.status as MessageStatus,
    errorCode: r.error_code,
    createdAt: r.created_at,
  };
}

// Resolve id arguments to storage ints. Repo inputs accept raw ints or the
// opaque handles; the SQL layer only ever sees ints.
export function convInt(id: string | number): number {
  return typeof id === "number" ? id : convCodec.parse(id);
}

export function msgInt(id: string | number): number {
  return typeof id === "number" ? id : msgCodec.parse(id);
}

export function toolInt(id: string | number): number {
  return typeof id === "number" ? id : toolCodec.parse(id);
}

/**
 * Reserve the next numeric autoincrement id for `table` WITHOUT inserting a row.
 *
 * The id must be known before the insert (the turn runner fans a tool.call /
 * reasoning event out to SSE subscribers before `upsertToolCall` /
 * `upsertReasoningBlock` persists the row), so it can't come from
 * `lastInsertRowid`. We bump the table's `sqlite_sequence` counter directly:
 * AUTOINCREMENT guarantees the next real insert takes a strictly larger id, so
 * reserved ids never collide with DB-minted ones, and a reserved-but-never-
 * inserted id is just a harmless gap. Single-process, so no cross-instance race.
 */
export function mintId(table: string): number {
  const db = getDb();
  const existing = db
    .prepare(`SELECT seq FROM sqlite_sequence WHERE name = ?`)
    .get(table) as { seq: number } | undefined;
  const next = (existing?.seq ?? 0) + 1;
  if (existing) {
    db.prepare(`UPDATE sqlite_sequence SET seq = ? WHERE name = ?`).run(
      next,
      table,
    );
  } else {
    db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)`).run(
      table,
      next,
    );
  }
  return next;
}
