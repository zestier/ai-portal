// Read/write access to `turn_idempotency`: a client-supplied key (per
// conversation) mapped to the message + turn a successful turns POST created.
// Lets a retried POST (e.g. after a client-side timeout) recover the original
// ids instead of creating a duplicate user message. See the migration for the
// contract.

import { getDb } from '../index';

export interface TurnIdempotencyRecord {
	turnId: string;
	userMessageId: string;
	title: string | null;
}

interface TurnIdempotencyRow {
	message_id: string;
	turn_id: string;
	title: string | null;
}

// Look up the original result for a previously-seen key, or null if this key
// hasn't been recorded for the conversation yet.
export function lookup(conversationId: string, key: string): TurnIdempotencyRecord | null {
	const row = getDb()
		.prepare(
			`SELECT message_id, turn_id, title
			   FROM turn_idempotency
			  WHERE conversation_id = ? AND idempotency_key = ?`
		)
		.get(conversationId, key) as TurnIdempotencyRow | undefined;
	if (!row) return null;
	return { turnId: row.turn_id, userMessageId: row.message_id, title: row.title };
}

// Record the result of a successfully-started turn against its key. Uses
// INSERT OR IGNORE so a concurrent winner that already claimed the key is never
// clobbered — the first write wins and later retries read it back via `lookup`.
export function record(input: {
	conversationId: string;
	key: string;
	messageId: string;
	turnId: string;
	title?: string | null;
}): void {
	getDb()
		.prepare(
			`INSERT OR IGNORE INTO turn_idempotency(
			   conversation_id, idempotency_key, message_id, turn_id, title, created_at
			 )
			 VALUES (?, ?, ?, ?, ?, ?)`
		)
		.run(
			input.conversationId,
			input.key,
			input.messageId,
			input.turnId,
			input.title ?? null,
			Date.now()
		);
}
