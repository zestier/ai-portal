import type Database from "better-sqlite3";
import { getDb } from "../../index";
import {
  conversationId as convCodec,
  messageId as msgCodec,
  toolCallId as toolCodec,
} from "$lib/ids";
import type {
  Message,
  MessageStatus,
  Role,
  ToolCallRecord,
  FileEditRecord,
  ReasoningBlockRecord,
} from "$lib/types";
import {
  convInt,
  msgInt,
  runInBatches,
  selectInBatches,
  rowToMessage,
  type BackgroundAgentLifecycleRow,
  type EditRow,
  type MsgRow,
  type ReasoningRow,
  type ToolRow,
} from "./rows";

export interface ListByConversationOptions {
  // When set, each of these caps the inline size (in UTF-8 bytes) of the
  // matching column: anything larger is omitted from the returned records and
  // flagged with the corresponding `*Truncated` / `*Bytes` markers. Used by
  // the conversation page so opening a long thread doesn't serialize megabytes
  // of collapsed-by-default tool output. Callers that need the real text
  // (export, fork, provider transcript replay, memory) pass nothing and get
  // exactly today's shape.
  inlineMaxBytes?: {
    args: number;
    result: number;
    diff: number;
    reasoning: number;
  };
}

// `length()` counts characters for TEXT; casting to BLOB first makes it count
// UTF-8 bytes, which is what actually lands on the wire.
function byteLen(col: string): string {
  return `length(CAST(${col} AS blob))`;
}

// Projects one large column as "inline if small, NULL if large" plus its byte
// size, so the trim decision happens in SQLite rather than after the whole blob
// has been marshalled into JS.
function trimmedColumn(col: string, alias: string, keepWhen = ""): string {
  return (
    `CASE WHEN ${keepWhen}${byteLen(col)} > ? THEN NULL ELSE ${col} END AS ${col}, ` +
    `${byteLen(col)} AS ${alias}`
  );
}

// A `task` or `proc` call's arguments ARE the subagent card's identity: its headline,
// agent_type / model / background pills and the "Retry extraction" affordance
// all render on the COLLAPSED card. Trimming them would leave a reloaded
// conversation full of unlabelled, un-retryable "subagent" rows, so they stay
// inline regardless of size. (`task` calls are a small minority, so this costs
// little.) Its result is only rendered once the card is opened, and is trimmed
// like any other.
const ALWAYS_INLINE_ARGS_TOOLS = "tool NOT IN ('task', 'proc') AND ";

// A `kind = 'content'` reasoning block is a sub-agent's spoken answer, rendered
// as markdown in the card's activity timeline with no expand step. Only real
// "thinking" blocks — collapsed until clicked — are trimmed.
//
// A block with no `duration_ms` is still open: the turn is streaming it right
// now, so it renders EXPANDED and the client keeps appending deltas to it. Its
// text has to arrive inline, or a reload mid-turn would append the rest of the
// thought onto an empty string and silently lose the streamed prefix. There is
// at most one such block per open, so keeping it costs nothing.
const ALWAYS_INLINE_REASONING =
  "kind <> 'content' AND duration_ms IS NOT NULL AND ";

export function listByConversation(
  conversationId: string | number,
  opts: ListByConversationOptions = {},
): Message[] {
  const intConv = convInt(conversationId);
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC",
    )
    .all(intConv) as MsgRow[];
  const msgs = rows.map(rowToMessage);
  attachRecords(msgs, opts);
  return msgs;
}

// Loads the tool-call / file-edit / reasoning records for already-fetched
// messages and attaches them in place, honoring `opts.inlineMaxBytes` when set
// (see `listByConversation`). Shared by every transcript read path so the
// window queries below (tail / index page / single message) can't drift from
// the full-list shape.
export function attachRecords(
  msgs: Message[],
  opts: ListByConversationOptions,
): void {
  if (msgs.length === 0) return;
  const db = getDb();
  const limits = opts.inlineMaxBytes;
  const trim = limits !== undefined;

  const toolCols = trim
    ? `id, message_id, tool, ${trimmedColumn("args_json", "args_bytes", ALWAYS_INLINE_ARGS_TOOLS)}, ` +
      `${trimmedColumn("result_json", "result_bytes")}, ` +
      `status, started_at, ended_at, text_offset, parent_tool_call_id`
    : "*";
  const editCols = trim
    ? `id, message_id, path, ${trimmedColumn("diff", "diff_bytes")}, ` +
      `created_at, text_offset, parent_tool_call_id`
    : "*";
  const reasoningCols = trim
    ? `id, message_id, segment_index, ` +
      `${trimmedColumn("text", "text_bytes", ALWAYS_INLINE_REASONING)}, ` +
      `kind, text_offset, started_at, duration_ms, parent_tool_call_id`
    : "*";

  const ids = msgs.map((m) => msgCodec.parse(m.id));
  const toolRows = selectInBatches<ToolRow>(
    db,
    ids,
    (placeholders) =>
      `SELECT ${toolCols} FROM tool_calls WHERE message_id IN (${placeholders}) ORDER BY started_at ASC`,
    // One bind per `CASE WHEN ... > ?`, in column order.
    limits ? [limits.args, limits.result] : [],
  );
  const toolIds = toolRows.map((t) => t.id);
  const lifecycleRows = selectInBatches<BackgroundAgentLifecycleRow>(
    db,
    toolIds,
    (placeholders) =>
      `SELECT * FROM background_agent_lifecycles WHERE tool_call_id IN (${placeholders})`,
  );
  const lifecycleByTool = new Map(
    lifecycleRows.map((r) => [r.tool_call_id, r]),
  );
  const editRows = selectInBatches<EditRow>(
    db,
    ids,
    (placeholders) =>
      `SELECT ${editCols} FROM file_edits WHERE message_id IN (${placeholders}) ORDER BY created_at ASC`,
    limits ? [limits.diff] : [],
  );
  const reasoningRows = selectInBatches<ReasoningRow>(
    db,
    ids,
    (placeholders) =>
      `SELECT ${reasoningCols} FROM reasoning_blocks WHERE message_id IN (${placeholders}) ORDER BY segment_index ASC`,
    limits ? [limits.reasoning] : [],
  );

  const byMsgT: Record<number, ToolCallRecord[]> = {};
  for (const t of toolRows) {
    const lifecycle = lifecycleByTool.get(t.id);
    // A NULL alongside a non-zero byte count means "trimmed", not "absent";
    // `result_json` is legitimately NULL while a call is still pending.
    const argsTruncated =
      trim && t.args_json === null && (t.args_bytes ?? 0) > 0;
    const resultTruncated =
      trim && t.result_json === null && (t.result_bytes ?? 0) > 0;
    (byMsgT[t.message_id] ??= []).push({
      id: toolCodec.encode(t.id),
      messageId: msgCodec.encode(t.message_id),
      tool: t.tool,
      argsJson: t.args_json,
      resultJson: t.result_json,
      ...(argsTruncated
        ? { argsTruncated: true, argsBytes: t.args_bytes }
        : {}),
      ...(resultTruncated
        ? { resultTruncated: true, resultBytes: t.result_bytes }
        : {}),
      status: t.status as ToolCallRecord["status"],
      startedAt: t.started_at,
      endedAt: t.ended_at,
      textOffset: t.text_offset,
      parentToolCallId:
        t.parent_tool_call_id === null
          ? null
          : toolCodec.encode(t.parent_tool_call_id),
      backgroundAgentStatus: lifecycle?.status ?? null,
      backgroundAgentId: lifecycle?.agent_id ?? null,
      backgroundAgentStartedAt: lifecycle?.started_at ?? null,
      backgroundAgentEndedAt: lifecycle?.ended_at ?? null,
    });
  }
  const byMsgE: Record<number, FileEditRecord[]> = {};
  for (const e of editRows) {
    const diffTruncated = trim && e.diff === null && (e.diff_bytes ?? 0) > 0;
    (byMsgE[e.message_id] ??= []).push({
      id: e.id,
      messageId: msgCodec.encode(e.message_id),
      path: e.path,
      diff: e.diff,
      ...(diffTruncated
        ? { diffTruncated: true, diffBytes: e.diff_bytes }
        : {}),
      createdAt: e.created_at,
      textOffset: e.text_offset,
      parentToolCallId:
        e.parent_tool_call_id === null
          ? null
          : toolCodec.encode(e.parent_tool_call_id),
    });
  }
  const byMsgR: Record<number, ReasoningBlockRecord[]> = {};
  for (const r of reasoningRows) {
    // `text` is NOT NULL in the schema, so a NULL here can only be the trim.
    const textTruncated = trim && r.text === null;
    (byMsgR[r.message_id] ??= []).push({
      id: r.id,
      messageId: msgCodec.encode(r.message_id),
      segmentIndex: r.segment_index,
      text: r.text,
      ...(textTruncated
        ? { textTruncated: true, textBytes: r.text_bytes }
        : {}),
      kind: r.kind === "content" ? "content" : "reasoning",
      textOffset: r.text_offset,
      startedAt: r.started_at,
      durationMs: r.duration_ms,
      parentToolCallId:
        r.parent_tool_call_id === null
          ? null
          : toolCodec.encode(r.parent_tool_call_id),
    });
  }
  for (const m of msgs) {
    m.toolCalls = byMsgT[msgCodec.parse(m.id)] ?? [];
    m.fileEdits = byMsgE[msgCodec.parse(m.id)] ?? [];
    m.reasoningBlocks = byMsgR[msgCodec.parse(m.id)] ?? [];
  }
}

// Newest `limit` messages (ASC order) with their records — the bounded
// hydrated tail of the backend-projected transcript. Loaded raw (untrimmed);
// the projection layer trims for the wire and computes summaries.
export function listRecent(
  conversationId: string | number,
  limit: number,
): Message[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
    )
    .all(convInt(conversationId), limit) as MsgRow[];
  const msgs = rows.reverse().map(rowToMessage);
  attachRecords(msgs, {});
  return msgs;
}

export interface IndexPageResult {
  /** Messages strictly older than `beforeId`, ASC order, at most `limit`. */
  messages: Message[];
  /** True when more rows exist beyond the returned page. */
  hasMore: boolean;
}

// Index-only page of messages older than `beforeId`, sharing the
// (created_at, id) tiebreak the rest of the repo uses so paging can't skip or
// duplicate a row that shares its timestamp with the cursor. Loaded raw — the
// projection layer shapes it into index entries. `limit + 1` rows are fetched
// so `hasMore` needs no second query.
export function listIndexPage(
  conversationId: string | number,
  beforeId: string | number,
  limit: number,
): IndexPageResult {
  const db = getDb();
  const intConv = convInt(conversationId);
  const before = db
    .prepare("SELECT * FROM messages WHERE conversation_id = ? AND id = ?")
    .get(intConv, msgInt(beforeId)) as MsgRow | undefined;
  if (!before) return { messages: [], hasMore: false };
  const rows = db
    .prepare(
      `SELECT * FROM messages
			  WHERE conversation_id = ?
			    AND (created_at < ? OR (created_at = ? AND id < ?))
			  ORDER BY created_at DESC, id DESC
			  LIMIT ?`,
    )
    .all(
      intConv,
      before.created_at,
      before.created_at,
      before.id,
      limit + 1,
    ) as MsgRow[];
  const hasMore = rows.length > limit;
  const msgs = rows.slice(0, limit).reverse().map(rowToMessage);
  attachRecords(msgs, {});
  return { messages: msgs, hasMore };
}

// One message with its records (the message-detail hydration endpoint). Loaded
// raw; the projection layer applies the generous INLINE_* trim for the body.
export function getMessage(
  conversationId: string | number,
  messageId: string | number,
): Message | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM messages WHERE conversation_id = ? AND id = ?")
    .get(convInt(conversationId), msgInt(messageId)) as MsgRow | undefined;
  if (!row) return null;
  const msg = rowToMessage(row);
  attachRecords([msg], {});
  return msg;
}

export function countMessages(conversationId: string | number): number {
  const row = getDb()
    .prepare("SELECT count(*) AS n FROM messages WHERE conversation_id = ?")
    .get(convInt(conversationId)) as { n: number };
  return row.n;
}

// multi-word query matches the literal substring including its spaces.
function ftsPhrase(term: string): string | null {
  if (term.length < 3) return null;
  return `"${term.replace(/"/g, "")}"`;
}

export function searchConversation(
  conversationId: string | number,
  query: string,
  opts: { limit?: number } = {},
): Message[] {
  const term = query.trim();
  if (!term) return [];
  const limit = opts.limit ?? 20;
  const phrase = ftsPhrase(term);
  const intConv = convInt(conversationId);
  // Sub-trigram (1-2 char) queries can't use the trigram index; fall back to a
  // scan to preserve the exact-literal contract for those rare short terms.
  if (!phrase) {
    const rows = getDb()
      .prepare(
        `SELECT * FROM messages
				  WHERE conversation_id = ?
				    AND instr(lower(content), lower(?)) > 0
				  ORDER BY created_at DESC, id DESC
				  LIMIT ?`,
      )
      .all(intConv, term, limit) as MsgRow[];
    return rows.map(rowToMessage).reverse();
  }
  // Trigram FTS5 MATCH narrows to messages whose content contains the literal
  // substring; instr then re-confirms the exact match (trigram is case-folded,
  // so e.g. "FOO" can MATCH "foo"). The index makes this fast on huge threads.
  const rows = getDb()
    .prepare(
      `SELECT m.* FROM messages_fts f
			   JOIN messages m ON m.id = f.message_id
			  WHERE f.conversation_id = ?
			    AND messages_fts MATCH ?
			    AND instr(lower(m.content), lower(?)) > 0
			  ORDER BY m.created_at DESC, m.id DESC
			  LIMIT ?`,
    )
    .all(intConv, phrase, term, limit) as MsgRow[];
  return rows.map(rowToMessage).reverse();
}

export interface AppendInput {
  role: Role;
  content: string;
  status?: MessageStatus;
  errorCode?: string | null;
}

export function append(
  conversationId: string | number,
  input: AppendInput,
): Message {
  const now = Date.now();
  const intConv = convInt(conversationId);
  const info = getDb()
    .prepare(
      `INSERT INTO messages(conversation_id, role, content, status, error_code, created_at, reasoning, reasoning_duration_ms)
			 VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .run(
      intConv,
      input.role,
      input.content,
      input.status ?? "complete",
      input.errorCode ?? null,
      now,
    );
  const id = Number(info.lastInsertRowid);
  return {
    id: msgCodec.encode(id),
    conversationId: convCodec.encode(intConv),
    role: input.role,
    content: input.content,
    status: input.status ?? "complete",
    errorCode: input.errorCode ?? null,
    createdAt: now,
  };
}

export function updateStatus(
  id: number,
  status: MessageStatus,
  errorCode?: string | null,
) {
  getDb()
    .prepare("UPDATE messages SET status = ?, error_code = ? WHERE id = ?")
    .run(status, errorCode ?? null, id);
}

export function updateContent(
  id: number,
  content: string,
  status: MessageStatus,
  errorCode?: string | null,
) {
  getDb()
    .prepare(
      "UPDATE messages SET content = ?, status = ?, error_code = ? WHERE id = ?",
    )
    .run(content, status, errorCode ?? null, id);
}

export function updateContentOnly(id: string | number, content: string) {
  getDb()
    .prepare("UPDATE messages SET content = ? WHERE id = ?")
    .run(content, msgInt(id));
}

export function truncateAfterAndUpdateUserMessage(
  conversationId: string | number,
  messageId: string | number,
  content: string,
): Message | null {
  const db = getDb();
  const intConv = convInt(conversationId);
  const intMsg = msgInt(messageId);
  const tx = db.transaction(() => {
    const target = db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? AND id = ?")
      .get(intConv, intMsg) as MsgRow | undefined;
    if (!target) return null;

    deleteMessagesAfter(db, intConv, target);

    db.prepare(
      `UPDATE messages
			    SET content = ?,
			        status = 'complete',
			        error_code = NULL
			  WHERE id = ?`,
    ).run(content, intMsg);

    return rowToMessage({
      ...target,
      content,
      status: "complete",
      error_code: null,
    });
  });
  return tx();
}

function deleteMessagesAfter(
  db: Database.Database,
  conversationId: number,
  target: MsgRow,
): void {
  const later = db
    .prepare(
      `SELECT id FROM messages
			  WHERE conversation_id = ?
			    AND (created_at > ? OR (created_at = ? AND id > ?))`,
    )
    .all(conversationId, target.created_at, target.created_at, target.id) as {
    id: number;
  }[];
  const laterIds = later.map((r) => r.id);
  if (laterIds.length === 0) return;
  runInBatches(
    db,
    laterIds,
    (placeholders) =>
      `DELETE FROM reasoning_blocks WHERE message_id IN (${placeholders})`,
  );
  runInBatches(
    db,
    laterIds,
    (placeholders) =>
      `DELETE FROM file_edits WHERE message_id IN (${placeholders})`,
  );
  // Deleting tool_calls cascades (ON DELETE CASCADE) to its child tables:
  // background_agent_lifecycles (migration 044). No manual cleanup of those
  // children is needed here — adding one would be dead code.
  runInBatches(
    db,
    laterIds,
    (placeholders) =>
      `DELETE FROM tool_calls WHERE message_id IN (${placeholders})`,
  );
  runInBatches(
    db,
    laterIds,
    (placeholders) => `DELETE FROM messages WHERE id IN (${placeholders})`,
  );
}

export function truncateAfterMessage(
  conversationId: string | number,
  messageId: string | number,
): boolean {
  const db = getDb();
  const intConv = convInt(conversationId);
  const tx = db.transaction(() => {
    const target = db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? AND id = ?")
      .get(intConv, msgInt(messageId)) as MsgRow | undefined;
    if (!target) return false;
    deleteMessagesAfter(db, intConv, target);
    return true;
  });
  return tx();
}

export function recoverInterruptedInFlight(now: number = Date.now()): {
  messages: number;
  toolCalls: number;
} {
  const db = getDb();
  const tx = db.transaction(() => {
    const msg = db
      .prepare(
        `UPDATE messages
				   SET status = 'interrupted',
				       error_code = COALESCE(error_code, 'server_restarted')
				 WHERE status = 'streaming'`,
      )
      .run();
    const tools = db
      .prepare(
        `UPDATE tool_calls
				   SET status = 'error',
				       ended_at = COALESCE(ended_at, ?)
				 WHERE status = 'pending'`,
      )
      .run(now);
    db.prepare(
      `UPDATE background_agent_lifecycles
			    SET status = 'failed',
			        ended_at = COALESCE(ended_at, ?)
			  WHERE status = 'running'`,
    ).run(now);
    return { messages: msg.changes, toolCalls: tools.changes };
  });
  return tx();
}
