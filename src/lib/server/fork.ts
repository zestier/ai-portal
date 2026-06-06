// "Edit earlier message" → fork-conversation service.
//
// Forking creates a NEW conversation seeded with the prefix of messages
// up to (but not including) the edited message, plus the edited user
// message as a fresh row. The new conversation shares the source's
// workdir — there is only one real project tree, and rolling it back
// would clobber other conversations. The per-turn git snapshot ref
// (`refs/portal/turns/{pre,post}/<msgId>`) remains in the repo if the
// user wants to manually diff against the captured state.
//
// The original conversation is left untouched. This is deliberately
// non-destructive: the user can always navigate back to the source
// thread.
//
// Two flavours:
//  1. EDIT  — target is a user message, `newContent` is the replacement
//             text. The clone includes everything *strictly before* the
//             edited message, and the edited message is appended as a
//             fresh user row.
//  2. RETRY — target is an assistant message, `newContent` is null.
//             The clone includes everything *up to and including* the
//             target assistant message, and no new user message is
//             appended — the user types their next prompt themselves in
//             the new conversation.
//
// Constraints:
//  - System messages can never be the fork target.
//  - The source conversation must not have a running turn.

import { ulid } from './db/ids';
import { getDb } from './db';
import * as convs from './db/repos/conversations';
import * as messages from './db/repos/messages';
import * as memoryRepo from './db/repos/memory';
import { getTurn } from './runtime/turn-runner';
import { log } from './log';
import type { Conversation, Message } from '$lib/types';

export type ForkError =
	| 'source_not_found'
	| 'message_not_found'
	| 'not_user_message'
	| 'unsupported_role'
	| 'content_required'
	| 'content_not_allowed'
	| 'source_busy';

export class ForkRejected extends Error {
	constructor(
		public readonly reason: ForkError,
		msg?: string
	) {
		super(msg ?? reason);
		this.name = 'ForkRejected';
	}
}

export interface ForkInput {
	userId: string;
	sourceConversationId: string;
	messageId: string;
	/**
	 * The replacement text for a user-message edit. Must be null/undefined
	 * for an assistant-message retry.
	 */
	newContent: string | null;
}

export interface ForkResult {
	conversation: Conversation;
	userMessage: Message | null;
}

/**
 * Edit `messageId` (a user message in `sourceConversationId`) and produce
 * a new forked conversation seeded with prior history + the edit. The
 * new conversation shares the source's workdir.
 */
export async function forkAtMessage(input: ForkInput): Promise<ForkResult> {
	const source = convs.get(input.sourceConversationId, input.userId);
	if (!source) throw new ForkRejected('source_not_found');

	const all = messages.listByConversation(source.id);
	const targetIdx = all.findIndex((m) => m.id === input.messageId);
	if (targetIdx < 0) throw new ForkRejected('message_not_found');
	const target = all[targetIdx];

	// Decide flavour from the target's role; validate inputs against it.
	let mode: 'edit' | 'retry';
	if (target.role === 'user') {
		if (input.newContent == null || input.newContent === '') {
			throw new ForkRejected(
				'content_required',
				'newContent is required when editing a user message.'
			);
		}
		mode = 'edit';
	} else if (target.role === 'assistant') {
		if (input.newContent != null) {
			throw new ForkRejected(
				'content_not_allowed',
				'newContent must be omitted when retrying an assistant message.'
			);
		}
		// Don't let the user retry from a half-finished assistant turn —
		// the post-snapshot for that message won't exist yet anyway, but
		// fail loudly instead of confusing the user with a no_snapshot.
		if (target.status !== 'complete') {
			throw new ForkRejected(
				'unsupported_role',
				'Can only retry from a completed assistant message.'
			);
		}
		mode = 'retry';
	} else {
		throw new ForkRejected('unsupported_role', `Cannot fork from a ${target.role} message.`);
	}

	const active = getTurn(source.id);
	if (active && active.status === 'running') {
		throw new ForkRejected('source_busy', 'Source conversation has a running turn.');
	}

	// The forked conversation reuses the source's workdir. We deliberately
	// do NOT roll the workdir back to the snapshot — multiple conversations
	// share the real project tree, and a destructive checkout would clobber
	// other in-flight work. The per-turn snapshot ref is still in the repo
	// (`refs/portal/turns/{pre,post}/<msgId>`) for manual `git diff` /
	// inspection if the user wants to compare states.
	const newId = convs.newId();
	const newConv = convs.create(input.userId, {
		id: newId,
		title: source.title,
		workdir: source.workdir,
		provider: source.provider,
		model: source.model,
		mode: source.mode,
		memoryMode: source.memoryMode,
		memoryExtractorModel: source.memoryExtractorModel,
		globalMemoryEnabled: source.globalMemoryEnabled,
		forkedFromConversationId: source.id,
		forkedFromMessageId: target.id
	});

	// Edit mode clones strictly before the target (so the new user message
	// replaces it). Retry mode clones up to AND including the target
	// assistant message (so its reply is preserved as context, and the
	// user picks up by typing the next prompt).
	const prefixEnd = mode === 'edit' ? targetIdx : targetIdx + 1;
	const prefix = all.slice(0, prefixEnd);
	const messageIdMap = cloneMessagePrefix(newConv.id, prefix);

	// Rebuild durable session memory from the append-only log, scoped to the
	// cloned prefix. Log entries linked to kept source messages are replayed
	// with message/item ids remapped to the fork, while rewound suffix entries
	// are left behind.
	const firstDiscarded = all[prefixEnd];
	const memoryCounts = memoryRepo.replaySessionMemoryLogForFork(source.id, newConv.id, {
		messageIdMap,
		createdBefore: firstDiscarded ? firstDiscarded.createdAt : Number.POSITIVE_INFINITY
	});

	let userMessage: Message | null = null;
	if (mode === 'edit') {
		userMessage = messages.append(newConv.id, { role: 'user', content: input.newContent! });
	}

	const refreshed = convs.get(newConv.id, input.userId);
	if (!refreshed) throw new Error('fork: created conversation disappeared');
	log.info('fork.created', {
		mode,
		source: source.id,
		newId: newConv.id,
		messageId: target.id,
		prefix: prefix.length,
		memory: memoryCounts
	});
	return { conversation: refreshed, userMessage };
}

function cloneMessagePrefix(targetConvId: string, prefix: Message[]): Map<string, string> {
	const db = getDb();
	messages.ensureBackgroundAgentLifecycleTable(db);
	const baseTs = Date.now() - prefix.length - 1;
	const messageIdMap = new Map<string, string>();
	const insertMsg = db.prepare(
		`INSERT INTO messages(id, conversation_id, role, content, status, error_code, created_at, reasoning, reasoning_duration_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
	);
	const insertTool = db.prepare(
		`INSERT INTO tool_calls(id, message_id, tool, args_json, result_json, status, started_at, ended_at, text_offset, parent_tool_call_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const insertLifecycle = db.prepare(
		`INSERT INTO background_agent_lifecycles(tool_call_id, agent_id, status, started_at, ended_at)
		 VALUES (?, ?, ?, ?, ?)`
	);
	const insertEdit = db.prepare(
		`INSERT INTO file_edits(id, message_id, path, diff, created_at, text_offset, parent_tool_call_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	);
	const insertReasoning = db.prepare(
		`INSERT INTO reasoning_blocks(id, message_id, segment_index, text, kind, text_offset, started_at, duration_ms, parent_tool_call_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const tx = db.transaction(() => {
		prefix.forEach((m, i) => {
			const newId = ulid();
			messageIdMap.set(m.id, newId);
			const ts = baseTs + i;
			insertMsg.run(newId, targetConvId, m.role, m.content, m.status, m.errorCode, ts);
			// Remap tool_call ids so parent_tool_call_id references stay
			// internally consistent within the cloned message.
			const toolIdRemap = new Map<string, string>();
			for (const t of m.toolCalls ?? []) {
				toolIdRemap.set(t.id, ulid());
			}
			for (const t of m.toolCalls ?? []) {
				const remappedToolId = toolIdRemap.get(t.id)!;
				insertTool.run(
					remappedToolId,
					newId,
					t.tool,
					t.argsJson,
					t.resultJson,
					t.status,
					t.startedAt,
					t.endedAt,
					t.textOffset,
					t.parentToolCallId ? (toolIdRemap.get(t.parentToolCallId) ?? null) : null
				);
				if (t.backgroundAgentStatus && t.backgroundAgentId && t.backgroundAgentStartedAt != null) {
					insertLifecycle.run(
						remappedToolId,
						t.backgroundAgentId,
						t.backgroundAgentStatus,
						t.backgroundAgentStartedAt,
						t.backgroundAgentEndedAt ?? null
					);
				}
			}
			for (const e of m.fileEdits ?? []) {
				insertEdit.run(
					ulid(),
					newId,
					e.path,
					e.diff,
					ts,
					e.textOffset,
					e.parentToolCallId ? (toolIdRemap.get(e.parentToolCallId) ?? null) : null
				);
			}
			for (const r of m.reasoningBlocks ?? []) {
				insertReasoning.run(
					ulid(),
					newId,
					r.segmentIndex,
					r.text,
					r.kind ?? 'reasoning',
					r.textOffset,
					r.startedAt,
					r.durationMs,
					r.parentToolCallId ? (toolIdRemap.get(r.parentToolCallId) ?? null) : null
				);
			}
		});
	});
	tx();
	return messageIdMap;
}
