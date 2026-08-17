import { getDb } from "../../index";
import type { ReasoningBlockRecord } from "$lib/types";
import { convInt, mintId, msgInt } from "./rows";

// Writes always carry real text: `reasoning_blocks.text` is NOT NULL, and only
// a *trimmed read* (see `inlineMaxBytes`) ever hands back a null. The id-ish
// fields stay ints at the storage boundary (handles parse at the caller).
export type ReasoningBlockWrite = Omit<
  ReasoningBlockRecord,
  "messageId" | "text" | "parentToolCallId"
> & {
  text: string;
  parentToolCallId: number | null;
};

export function mintReasoningBlockId(): number {
  return mintId("reasoning_blocks");
}

export function insertFileEdit(
  messageId: string | number,
  path: string,
  diff: string,
  textOffset: number | null = null,
  parentToolCallId: number | null = null,
) {
  getDb()
    .prepare(
      `INSERT INTO file_edits(message_id, path, diff, created_at, text_offset, parent_tool_call_id)
			 VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      msgInt(messageId),
      path,
      diff,
      Date.now(),
      textOffset,
      parentToolCallId,
    );
}

export function getFileEditDiffForOwner(
  conversationId: string | number,
  fileEditId: number,
  userId: number,
): { value: string | null } | null {
  const row = getDb()
    .prepare(
      `SELECT fe.diff AS value
			   FROM file_edits fe
			   JOIN messages m ON m.id = fe.message_id
			   JOIN conversations c ON c.id = m.conversation_id
			  WHERE fe.id = ? AND m.conversation_id = ? AND c.user_id = ?`,
    )
    .get(fileEditId, convInt(conversationId), userId) as
    { value: string | null } | undefined;
  return row ?? null;
}

export function getReasoningTextForOwner(
  conversationId: string | number,
  reasoningBlockId: number,
  userId: number,
): { value: string | null } | null {
  const row = getDb()
    .prepare(
      `SELECT rb.text AS value
			   FROM reasoning_blocks rb
			   JOIN messages m ON m.id = rb.message_id
			   JOIN conversations c ON c.id = m.conversation_id
			  WHERE rb.id = ? AND m.conversation_id = ? AND c.user_id = ?`,
    )
    .get(reasoningBlockId, convInt(conversationId), userId) as
    { value: string | null } | undefined;
  return row ?? null;
}

export function upsertReasoningBlock(
  messageId: string | number,
  r: ReasoningBlockWrite,
) {
  const intMsg = msgInt(messageId);
  getDb()
    .prepare(
      `INSERT INTO reasoning_blocks(id, message_id, segment_index, text, kind, text_offset, started_at, duration_ms, parent_tool_call_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   message_id = excluded.message_id,
			   segment_index = excluded.segment_index,
			   text = excluded.text,
			   kind = excluded.kind,
			   text_offset = excluded.text_offset,
			   started_at = excluded.started_at,
			   duration_ms = excluded.duration_ms,
			   parent_tool_call_id = excluded.parent_tool_call_id`,
    )
    .run(
      r.id,
      intMsg,
      r.segmentIndex,
      r.text,
      r.kind ?? "reasoning",
      r.textOffset,
      r.startedAt,
      r.durationMs ?? null,
      r.parentToolCallId ?? null,
    );
}

export function insertReasoningBlock(
  messageId: string | number,
  r: ReasoningBlockWrite,
) {
  getDb()
    .prepare(
      `INSERT INTO reasoning_blocks(id, message_id, segment_index, text, kind, text_offset, started_at, duration_ms, parent_tool_call_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.id,
      msgInt(messageId),
      r.segmentIndex,
      r.text,
      r.kind ?? "reasoning",
      r.textOffset,
      r.startedAt,
      r.durationMs ?? null,
      r.parentToolCallId ?? null,
    );
}
