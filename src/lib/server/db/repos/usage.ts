// Per-conversation context-window usage snapshot. Updated whenever the SDK
// emits a `session.usage_info` event (translated into a `context.usage`
// PortalEvent by the bridge and persisted by the turn runner).

import { getDb } from '../index';
import { conversationId as convCodec } from '$lib/ids';
import type { ConversationUsage } from '$lib/types';

interface UsageRow {
	conversation_id: number;
	current_tokens: number;
	token_limit: number;
	messages_length: number;
	system_tokens: number | null;
	conversation_tokens: number | null;
	tool_definitions_tokens: number | null;
	updated_at: number;
}

function rowToUsage(r: UsageRow): ConversationUsage {
	return {
		conversationId: convCodec.encode(r.conversation_id),
		currentTokens: r.current_tokens,
		tokenLimit: r.token_limit,
		messagesLength: r.messages_length,
		systemTokens: r.system_tokens,
		conversationTokens: r.conversation_tokens,
		toolDefinitionsTokens: r.tool_definitions_tokens,
		updatedAt: r.updated_at
	};
}

export interface UsageSnapshot {
	currentTokens: number;
	tokenLimit: number;
	messagesLength: number;
	systemTokens?: number | null;
	conversationTokens?: number | null;
	toolDefinitionsTokens?: number | null;
}

export function get(conversationId: string | number): ConversationUsage | null {
	const intConv =
		typeof conversationId === 'number' ? conversationId : convCodec.parse(conversationId);
	const r = getDb()
		.prepare('SELECT * FROM conversation_usage WHERE conversation_id = ?')
		.get(intConv) as UsageRow | undefined;
	return r ? rowToUsage(r) : null;
}

export function upsert(conversationId: string | number, s: UsageSnapshot): void {
	const intConv =
		typeof conversationId === 'number' ? conversationId : convCodec.parse(conversationId);
	getDb()
		.prepare(
			`INSERT INTO conversation_usage(
				conversation_id, current_tokens, token_limit, messages_length,
				system_tokens, conversation_tokens, tool_definitions_tokens, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(conversation_id) DO UPDATE SET
				current_tokens          = excluded.current_tokens,
				token_limit             = excluded.token_limit,
				messages_length         = excluded.messages_length,
				system_tokens           = excluded.system_tokens,
				conversation_tokens     = excluded.conversation_tokens,
				tool_definitions_tokens = excluded.tool_definitions_tokens,
				updated_at              = excluded.updated_at`
		)
		.run(
			intConv,
			s.currentTokens,
			s.tokenLimit,
			s.messagesLength,
			s.systemTokens ?? null,
			s.conversationTokens ?? null,
			s.toolDefinitionsTokens ?? null,
			Date.now()
		);
}

export function remove(conversationId: string | number): void {
	getDb()
		.prepare('DELETE FROM conversation_usage WHERE conversation_id = ?')
		.run(typeof conversationId === 'number' ? conversationId : convCodec.parse(conversationId));
}
