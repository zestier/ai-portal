// Per-conversation context-window usage snapshot. Persisted by the turn runner
// from each `context.usage` PortalEvent (emitted once per turn by the pi
// session at agent_end) and read on page load to seed the header meter.

import { getDb } from "../index";
import { conversationId as convCodec } from "$lib/ids";
import type { ConversationUsage } from "$lib/types";

interface UsageRow {
  conversation_id: number;
  current_tokens: number;
  token_limit: number;
  updated_at: number;
}

function rowToUsage(r: UsageRow): ConversationUsage {
  return {
    conversationId: convCodec.encode(r.conversation_id),
    currentTokens: r.current_tokens,
    tokenLimit: r.token_limit,
    updatedAt: r.updated_at,
  };
}

export interface UsageSnapshot {
  currentTokens: number;
  tokenLimit: number;
}

export function get(conversationId: string | number): ConversationUsage | null {
  const intConv =
    typeof conversationId === "number"
      ? conversationId
      : convCodec.parse(conversationId);
  const r = getDb()
    .prepare("SELECT * FROM conversation_usage WHERE conversation_id = ?")
    .get(intConv) as UsageRow | undefined;
  return r ? rowToUsage(r) : null;
}

export function upsert(
  conversationId: string | number,
  s: UsageSnapshot,
): void {
  const intConv =
    typeof conversationId === "number"
      ? conversationId
      : convCodec.parse(conversationId);
  getDb()
    .prepare(
      `INSERT INTO conversation_usage(
				conversation_id, current_tokens, token_limit, updated_at
			) VALUES (?, ?, ?, ?)
			ON CONFLICT(conversation_id) DO UPDATE SET
				current_tokens          = excluded.current_tokens,
				token_limit             = excluded.token_limit,
				updated_at              = excluded.updated_at`,
    )
    .run(intConv, s.currentTokens, s.tokenLimit, Date.now());
}

export function remove(conversationId: string | number): void {
  getDb()
    .prepare("DELETE FROM conversation_usage WHERE conversation_id = ?")
    .run(
      typeof conversationId === "number"
        ? conversationId
        : convCodec.parse(conversationId),
    );
}
