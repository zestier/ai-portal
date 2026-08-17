import { getDb } from "../../index";
import {
  conversationId as convCodec,
  messageId as msgCodec,
  toolCallId as toolCodec,
} from "$lib/ids";
import type { Role, ToolCallRecord } from "$lib/types";
import { convInt, mintId, msgInt, toolInt, type ToolRow } from "./rows";

// Writes always carry the real arguments: only the read side (a trimmed page
// payload) can produce a null `argsJson`, and `tool_calls.args_json` is NOT
// NULL. Requiring it here keeps a trimmed record from being wired into an
// insert/clone path and failing as a runtime constraint violation instead of a
// compile error. Id-ish fields stay ints at the storage boundary (handles
// parse at the caller).
export type ToolCallInsert = Omit<
  ToolCallRecord,
  "messageId" | "id" | "parentToolCallId" | "argsJson"
> & {
  id: number;
  parentToolCallId: number | null;
  argsJson: string;
};

export function mintToolCallId(): number {
  return mintId("tool_calls");
}

export function insertToolCall(messageId: string | number, t: ToolCallInsert) {
  const intMsg = msgInt(messageId);
  getDb()
    .prepare(
      `INSERT INTO tool_calls(
			   id, message_id, tool, args_json, result_json, status, started_at, ended_at,
			   text_offset, parent_tool_call_id
			 )
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      t.id,
      intMsg,
      t.tool,
      t.argsJson,
      t.resultJson,
      t.status,
      t.startedAt,
      t.endedAt,
      t.textOffset,
      t.parentToolCallId ?? null,
    );
}

export function upsertToolCall(messageId: string | number, t: ToolCallInsert) {
  const intMsg = msgInt(messageId);
  getDb()
    .prepare(
      `INSERT INTO tool_calls(
			   id, message_id, tool, args_json, result_json, status, started_at, ended_at,
			   text_offset, parent_tool_call_id
			 )
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   message_id = excluded.message_id,
			   tool = excluded.tool,
			   args_json = excluded.args_json,
			   result_json = excluded.result_json,
			   status = excluded.status,
			   started_at = excluded.started_at,
			   ended_at = excluded.ended_at,
			   text_offset = excluded.text_offset,
			   parent_tool_call_id = excluded.parent_tool_call_id`,
    )
    .run(
      t.id,
      intMsg,
      t.tool,
      t.argsJson,
      t.resultJson,
      t.status,
      t.startedAt,
      t.endedAt,
      t.textOffset,
      t.parentToolCallId ?? null,
    );
}

export function getToolCallArgs(id: number): unknown | null {
  const row = getDb()
    .prepare("SELECT args_json FROM tool_calls WHERE id = ?")
    .get(id) as { args_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.args_json);
  } catch {
    return null;
  }
}

export function updateToolCall(
  id: number,
  patch: Partial<Pick<ToolCallRecord, "resultJson" | "status" | "endedAt">>,
) {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.resultJson !== undefined) {
    fields.push("result_json = ?");
    values.push(patch.resultJson);
  }
  if (patch.status !== undefined) {
    fields.push("status = ?");
    values.push(patch.status);
  }
  if (patch.endedAt !== undefined) {
    fields.push("ended_at = ?");
    values.push(patch.endedAt);
  }
  if (fields.length === 0) return;
  values.push(id);
  getDb()
    .prepare(`UPDATE tool_calls SET ${fields.join(", ")} WHERE id = ?`)
    .run(...values);
}

export function updateBackgroundAgentLifecycle(
  toolCallId: number,
  agentId: string,
  status: "running" | "completed" | "failed",
  now: number = Date.now(),
) {
  const db = getDb();
  db.prepare(
    `INSERT INTO background_agent_lifecycles(
		   tool_call_id, agent_id, status, started_at, ended_at
		 )
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(tool_call_id) DO UPDATE SET
		   agent_id = excluded.agent_id,
		   status = CASE
		     WHEN background_agent_lifecycles.status IN ('completed', 'failed')
		       THEN background_agent_lifecycles.status
		     ELSE excluded.status
		   END,
		   started_at = min(background_agent_lifecycles.started_at, excluded.started_at),
		   ended_at = COALESCE(background_agent_lifecycles.ended_at, excluded.ended_at)`,
  ).run(toolCallId, agentId, status, now, status === "running" ? null : now);
}

export interface ToolCallWithConversation extends ToolCallRecord {
  // This lookup always reads the stored row directly, so the args are never
  // the page payload's trimmed marker — narrow the type back to non-null for
  // the rerun flow, which needs the exact original arguments.
  argsJson: string;
  conversationId: string;
  conversationUserId: number;
  messageRole: Role;
}

export function getToolCallForConversation(
  conversationId: string | number,
  toolCallId: string | number,
): ToolCallWithConversation | null {
  const db = getDb();
  const intConv = convInt(conversationId);
  const row = db
    .prepare(
      `SELECT tc.*,
			        m.conversation_id,
			        m.role AS message_role,
			        c.user_id AS conversation_user_id,
			        bal.agent_id AS background_agent_id,
			        bal.status AS background_agent_status,
			        bal.started_at AS background_agent_started_at,
			        bal.ended_at AS background_agent_ended_at
			   FROM tool_calls tc
			   JOIN messages m ON m.id = tc.message_id
			   JOIN conversations c ON c.id = m.conversation_id
			   LEFT JOIN background_agent_lifecycles bal ON bal.tool_call_id = tc.id
			  WHERE tc.id = ? AND m.conversation_id = ?`,
    )
    .get(toolInt(toolCallId), intConv) as
    | (ToolRow & {
        conversation_id: number;
        conversation_user_id: number;
        message_role: string;
        background_agent_id: string | null;
        background_agent_status: "running" | "completed" | "failed" | null;
        background_agent_started_at: number | null;
        background_agent_ended_at: number | null;
      })
    | undefined;
  if (!row) return null;
  return {
    id: toolCodec.encode(row.id),
    messageId: msgCodec.encode(row.message_id),
    tool: row.tool,
    // `SELECT tc.*` on a NOT NULL column: never actually null, and never
    // trimmed (this path doesn't go through listByConversation).
    argsJson: row.args_json ?? "",
    resultJson: row.result_json,
    status: row.status as ToolCallRecord["status"],
    startedAt: row.started_at,
    endedAt: row.ended_at,
    textOffset: row.text_offset,
    parentToolCallId:
      row.parent_tool_call_id === null
        ? null
        : toolCodec.encode(row.parent_tool_call_id),
    backgroundAgentStatus: row.background_agent_status,
    backgroundAgentId: row.background_agent_id,
    backgroundAgentStartedAt: row.background_agent_started_at,
    backgroundAgentEndedAt: row.background_agent_ended_at,
    conversationId: convCodec.encode(row.conversation_id),
    conversationUserId: row.conversation_user_id,
    messageRole: row.message_role as Role,
  };
}

// Full text of one large field that a trimmed conversation payload omitted.
// Ownership is enforced in the query itself (tool call → message →
// conversation owner), so a mismatched user gets the same `null` an unknown id
// does and the endpoint can 404 without leaking existence.
export function getToolCallFieldForOwner(
  conversationId: string | number,
  toolCallId: string | number,
  userId: number,
  field: "args" | "result",
): { value: string | null } | null {
  const column = field === "args" ? "tc.args_json" : "tc.result_json";
  const row = getDb()
    .prepare(
      `SELECT ${column} AS value
			   FROM tool_calls tc
			   JOIN messages m ON m.id = tc.message_id
			   JOIN conversations c ON c.id = m.conversation_id
			  WHERE tc.id = ? AND m.conversation_id = ? AND c.user_id = ?`,
    )
    .get(toolInt(toolCallId), convInt(conversationId), userId) as
    { value: string | null } | undefined;
  return row ?? null;
}
