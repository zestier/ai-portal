import { getDb } from "../../index";
import { appendSessionMemoryLog } from "./common";
import {
  convInt,
  rowToToolCall,
  safeJson,
  type MemoryToolCall,
  type ToolCallRow,
} from "./rows";

export function recordToolCall(
  conversationId: string | number,
  input: {
    turnId?: string | null | undefined;
    toolName: string;
    arguments: unknown;
    resultSummary: string;
    resultIds?: number[] | undefined;
  },
): MemoryToolCall {
  const now = Date.now();
  const intConv = convInt(conversationId);
  const info = getDb()
    .prepare(
      `INSERT INTO memory_tool_calls(
			   conversation_id, turn_id, tool_name, arguments_json, result_summary,
			   result_ids_json, created_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      intConv,
      input.turnId ?? null,
      input.toolName,
      safeJson(input.arguments),
      input.resultSummary,
      safeJson(input.resultIds ?? []),
      now,
    );
  const id = Number(info.lastInsertRowid);
  const row = getDb()
    .prepare("SELECT * FROM memory_tool_calls WHERE id = ?")
    .get(id) as ToolCallRow;
  appendSessionMemoryLog(getDb(), intConv, {
    eventKind: "tool_call.create",
    itemType: "tool_call",
    itemId: id,
    turnId: input.turnId ?? null,
    payload: { toolCall: rowToToolCall(row) },
  });
  return rowToToolCall(row);
}

export function listToolCalls(
  conversationId: number,
  opts: { limit?: number } = {},
): MemoryToolCall[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM memory_tool_calls
			  WHERE conversation_id = ?
			  ORDER BY created_at DESC LIMIT ?`,
    )
    .all(conversationId, opts.limit ?? 50) as ToolCallRow[];
  return rows.map(rowToToolCall);
}
