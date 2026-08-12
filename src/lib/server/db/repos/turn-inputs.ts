// Read/write access to `turn_inputs`: the full provider input captured per
// turn (keyed by the triggering user message). Pure observability — see the
// migration and the `TurnInput` type for the contract.

import { getDb } from '../index';
import type { InitialMessagePreview, TurnInput } from '$lib/types';

interface TurnInputRow {
	message_id: string;
	conversation_id: string;
	turn_id: string | null;
	full_input: string;
	prompt_body: string;
	prelude: string;
	model: string | null;
	mode: string | null;
	memory_mode: string | null;
	initial_messages: string | null;
	created_at: number;
}

export interface RecordTurnInput {
	messageId: string;
	conversationId: string;
	turnId?: string | null;
	fullInput: string;
	promptBody: string;
	prelude: string;
	model?: string | null;
	mode?: string | null;
	memoryMode?: string | null;
	initialMessages?: InitialMessagePreview[] | null;
}

export function record(input: RecordTurnInput): void {
	const db = getDb();
	db.prepare(
		`INSERT INTO turn_inputs(
		   message_id, conversation_id, turn_id, full_input, prompt_body, prelude,
		   model, mode, memory_mode, initial_messages, created_at
		 )
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(message_id) DO UPDATE SET
		   conversation_id = excluded.conversation_id,
		   turn_id = excluded.turn_id,
		   full_input = excluded.full_input,
		   prompt_body = excluded.prompt_body,
		   prelude = excluded.prelude,
		   model = excluded.model,
		   mode = excluded.mode,
		   memory_mode = excluded.memory_mode,
		   initial_messages = excluded.initial_messages,
		   created_at = excluded.created_at`
	).run(
		input.messageId,
		input.conversationId,
		input.turnId ?? null,
		input.fullInput,
		input.promptBody,
		input.prelude,
		input.model ?? null,
		input.mode ?? null,
		input.memoryMode ?? null,
		input.initialMessages ? JSON.stringify(input.initialMessages) : null,
		Date.now()
	);
}

export function get(conversationId: string, messageId: string): TurnInput | null {
	const db = getDb();
	const row = db
		.prepare('SELECT * FROM turn_inputs WHERE conversation_id = ? AND message_id = ?')
		.get(conversationId, messageId) as TurnInputRow | undefined;
	if (!row) return null;
	return rowToTurnInput(row);
}

function rowToTurnInput(r: TurnInputRow): TurnInput {
	let initialMessages: InitialMessagePreview[] | null = null;
	if (r.initial_messages) {
		try {
			initialMessages = JSON.parse(r.initial_messages) as InitialMessagePreview[];
		} catch {
			initialMessages = null;
		}
	}
	return {
		messageId: r.message_id,
		conversationId: r.conversation_id,
		turnId: r.turn_id,
		fullInput: r.full_input,
		promptBody: r.prompt_body,
		prelude: r.prelude,
		model: r.model,
		mode: r.mode,
		memoryMode: r.memory_mode,
		initialMessages,
		createdAt: r.created_at
	};
}
