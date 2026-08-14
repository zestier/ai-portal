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
// Forking is non-destructive and read-only with respect to the source, so
// it is allowed even while the source has a running turn. To avoid two turns
// racing in the shared workdir without the user opting in, an edit-fork made
// while the source is busy is created with the prefix only (no trailing user
// row) and its turn is NOT auto-started — the edited text is handed back for
// composer prefill so the user starts it manually.
//
// Constraints:
//  - System messages can never be the fork target.

import { getDb } from './db';
import { conversationId as convCodec, messageId as msgCodec, toolCallId as toolCodec } from '$lib/ids';
import * as convs from './db/repos/conversations';
import * as messages from './db/repos/messages';
import * as memoryRepo from './db/repos/memory';
import { getTurn } from './runtime/turn-runner';
import { log } from './log';
import type { Conversation, Message } from '$lib/types';
import { getSnapshot } from './snapshots';
import {
	createManagedWorktreeFromSnapshot,
	rollbackManagedWorktree,
	type ManagedWorktreeMetadata
} from './worktrees';

export type ForkError =
	| 'source_not_found'
	| 'message_not_found'
	| 'not_user_message'
	| 'unsupported_role'
	| 'content_required'
	| 'content_not_allowed'
	| 'no_snapshot';

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
	userId: number;
	sourceConversationId: string | number;
	messageId: string | number;
	/**
	 * The replacement text for a user-message edit. Must be null/undefined
	 * for an assistant-message retry.
	 */
	newContent: string | null;
	/** Opt into a new linked worktree restored to the selected snapshot. */
	workspaceKind?: 'shared' | 'managed-worktree';
}

export interface ForkResult {
	conversation: Conversation;
	userMessage: Message | null;
	/**
	 * True when the source had a running turn and this fork's turn was NOT
	 * auto-started (the caller should let the user start it manually).
	 */
	deferred: boolean;
}

/**
 * Edit `messageId` (a user message in `sourceConversationId`) and produce
 * a new forked conversation seeded with prior history + the edit. The
 * new conversation shares the source's workdir.
 */
export async function forkAtMessage(input: ForkInput): Promise<ForkResult> {
	const source = convs.get(input.sourceConversationId, input.userId);
	if (!source) throw new ForkRejected('source_not_found');

	const sourceConvInt = typeof input.sourceConversationId === 'number' ? input.sourceConversationId : convCodec.parse(input.sourceConversationId);
	const all = messages.listByConversation(sourceConvInt);
	const targetIdx = all.findIndex((m) => msgCodec.parse(m.id) === input.messageId);
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

	// Forking only reads the source's messages + memory and clones them into a
	// brand-new conversation; the source thread is never mutated, so a running
	// source turn is not a hard blocker. It does, however, change whether we
	// auto-start the fork's turn: doing so while the source is mid-turn would
	// race a second turn against the shared workdir without the user opting in.
	const active = getTurn(convCodec.parse(source.id));
	const sourceBusy = active?.status === 'running';

	// A busy source defers an edit-fork: we create the fork with the prefix
	// only (no trailing user row to "resume") and stash the edited text as the
	// new conversation's composer draft instead of auto-starting its turn. The
	// draft is persisted on the conversation row so it survives reload/navigation
	// and is seeded into the composer on load; the user presses Send to start
	// the turn, explicitly opting into a concurrent turn in the shared workdir.
	// A managed checkout has one owning conversation and is removed with that
	// conversation, so a fork must receive its own checkout rather than sharing
	// the source path. Use the persisted repository source because the source
	// checkout itself is disposable.
	const isolate =
		input.workspaceKind === 'managed-worktree' || source.workspaceKind === 'managed-worktree';
	const deferred = mode === 'edit' && sourceBusy && !isolate;
	const draftPrompt = deferred ? input.newContent! : null;
	let managedWorktree: ManagedWorktreeMetadata | null = null;
	// Create the conversation row first: with integer PKs the id can no longer be
	// minted ahead of the insert, and the worktree path/branch derive from it.
	// The row is created with the source's workdir; if this is an isolating fork
	// the managed-worktree metadata and real path are filled in below.
	const newConv = convs.create(input.userId, {
		title: source.title,
		workdir: source.workdir,
		workspaceKind: 'shared',
		workspaceKey: source.workspaceKey,
		model: source.model,
		mode: source.mode,
		approvalMode: source.approvalMode === 'auto-deny' ? 'auto-deny' : 'ask',
		memoryMode: source.memoryMode,
		memoryExtractorModel: source.memoryExtractorModel,
		adversaryModel: source.adversaryModel,
		globalMemoryEnabled: source.globalMemoryEnabled,
		disabledToolGroups: source.disabledToolGroups,
		forkedFromConversationId: convCodec.parse(source.id),
		forkedFromMessageId: msgCodec.parse(target.id),
		draftPrompt
	});
	if (isolate) {
		const snapshotKind = mode === 'edit' ? 'pre' : 'post';
		const snapshot = getSnapshot(msgCodec.parse(target.id), snapshotKind);
		if (!snapshot) {
			throw new ForkRejected('no_snapshot', 'No snapshot exists for this message.');
		}
		const sourceWorkdir =
			source.workspaceKind === 'managed-worktree'
				? convs.getManagedWorktree(convCodec.parse(source.id), input.userId)?.sourceWorkdir
				: source.workdir;
		if (!sourceWorkdir) {
			throw new ForkRejected('source_not_found', 'Managed source workspace is unavailable.');
		}
		managedWorktree = await createManagedWorktreeFromSnapshot({
			sourceWorkdir,
			userId: String(input.userId),
			conversationId: String(convCodec.parse(newConv.id)),
			...(snapshot.baseCommitSha ? { baseCommitSha: snapshot.baseCommitSha } : {}),
			treeSha: snapshot.treeSha
		});
	}

	// The forked conversation reuses the source's workdir. We deliberately
	// do NOT roll the workdir back to the snapshot — multiple conversations
	// share the real project tree, and a destructive checkout would clobber
	// other in-flight work. The per-turn snapshot ref is still in the repo
	// (`refs/portal/turns/{pre,post}/<msgId>`) for manual `git diff` /
	// inspection if the user wants to compare states.
	// Wrap the entire clone — managed-worktree metadata, message prefix, memory
	// replay, and the trailing user append — in a single transaction so a throw
	// in any later step rolls back the fork's new rows. The conversation row
	// itself was committed above (its id was needed for the worktree path), so a
	// failure here removes it in the catch below. All of these helpers are
	// synchronous better-sqlite3 calls (no `await`), and better-sqlite3 promotes
	// the nested `.transaction()` calls inside `cloneMessagePrefix` / the repos to
	// SAVEPOINTs, so nesting is safe.
	const tx = getDb().transaction((): ForkResult => {
		if (managedWorktree) {
			convs.setManagedWorktree(convCodec.parse(newConv.id), managedWorktree);
			getDb()
				.prepare(`UPDATE conversations SET workdir = ?, workspace_kind = ? WHERE id = ?`)
				.run(managedWorktree.path, 'managed-worktree', convCodec.parse(newConv.id));
		}

		// Edit mode clones strictly before the target (so the new user message
		// replaces it). Retry mode clones up to AND including the target
		// assistant message (so its reply is preserved as context, and the
		// user picks up by typing the next prompt).
		const prefixEnd = mode === 'edit' ? targetIdx : targetIdx + 1;
		const prefix = all.slice(0, prefixEnd);
		const messageIdMap = cloneMessagePrefix(convCodec.parse(newConv.id), prefix);

		// Rebuild durable session memory from the append-only log, scoped to the
		// cloned prefix. Log entries linked to kept source messages are replayed
		// with message/item ids remapped to the fork, while rewound suffix entries
		// are left behind.
		const firstDiscarded = all[prefixEnd];
		const memoryCounts = memoryRepo.replaySessionMemoryLogForFork(
			convCodec.parse(source.id),
			convCodec.parse(newConv.id),
			{
				messageIdMap,
				createdBefore: firstDiscarded ? firstDiscarded.createdAt : Number.POSITIVE_INFINITY
			}
		);

		let userMessage: Message | null = null;
		// Only an idle-source edit-fork auto-starts: append the user row so the
		// caller kicks off the turn. A deferred edit-fork (busy source) leaves the
		// prefix untouched and relies on the persisted draft_prompt seeded above.
		if (mode === 'edit' && !deferred) {
			userMessage = messages.append(convCodec.parse(newConv.id), {
				role: 'user',
				content: input.newContent!
			});
		}

		const refreshed = convs.get(convCodec.parse(newConv.id), input.userId);
		if (!refreshed) throw new Error('fork: created conversation disappeared');
		log.info('fork.created', {
			mode,
			source: source.id,
			newId: newConv.id,
			messageId: target.id,
			prefix: prefix.length,
			memory: memoryCounts,
			deferred
		});
		return { conversation: refreshed, userMessage, deferred };
	});
	try {
		return tx();
	} catch (cause) {
		// The conversation row was committed before this transaction ran, so an
		// isolation failure must clean it up explicitly — otherwise an empty fork
		// stays visible. The checkout is rolled back too.
		convs.remove(convCodec.parse(newConv.id), input.userId);
		if (managedWorktree) {
			await rollbackManagedWorktree(managedWorktree).catch((cleanupError) => {
				log.warn('fork.worktree_cleanup_failed', {
					conversationId: newConv.id,
					err: String(cleanupError)
				});
			});
		}
		throw cause;
	}
}

function cloneMessagePrefix(targetConvId: number, prefix: Message[]): Map<number, number> {
	const db = getDb();
	const baseTs = Date.now() - prefix.length - 1;
	const messageIdMap = new Map<number, number>();
	const insertMsg = db.prepare(
		`INSERT INTO messages(conversation_id, role, content, status, error_code, created_at, reasoning, reasoning_duration_ms)
		 VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`
	);
	const insertTool = db.prepare(
		`INSERT INTO tool_calls(message_id, tool, args_json, result_json, status, started_at, ended_at, text_offset, parent_tool_call_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const setToolParent = db.prepare(`UPDATE tool_calls SET parent_tool_call_id = ? WHERE id = ?`);
	const insertLifecycle = db.prepare(
		`INSERT INTO background_agent_lifecycles(tool_call_id, agent_id, status, started_at, ended_at)
		 VALUES (?, ?, ?, ?, ?)`
	);
	const insertEdit = db.prepare(
		`INSERT INTO file_edits(message_id, path, diff, created_at, text_offset, parent_tool_call_id)
		 VALUES (?, ?, ?, ?, ?, ?)`
	);
	const insertReasoning = db.prepare(
		`INSERT INTO reasoning_blocks(message_id, segment_index, text, kind, text_offset, started_at, duration_ms, parent_tool_call_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const tx = db.transaction(() => {
		prefix.forEach((m, i) => {
			const ts = baseTs + i;
			const newMsgId = Number(
				insertMsg.run(targetConvId, m.role, m.content, m.status, m.errorCode, ts).lastInsertRowid
			);
			messageIdMap.set(msgCodec.parse(m.id), newMsgId);
			// Tool_call ids are minted by the insert, so parent_tool_call_id
			// references can't be filled in the same pass (a parent may appear
			// anywhere in the message's call list). Insert with a NULL parent
			// first, then patch the references once every id is known — keeping
			// the cloned message internally consistent regardless of ordering.
			const toolIdRemap = new Map<number, number>();
			for (const t of m.toolCalls ?? []) {
				const remappedToolId = Number(
					insertTool.run(
						newMsgId,
						t.tool,
						t.argsJson,
						t.resultJson,
						t.status,
						t.startedAt,
						t.endedAt,
						t.textOffset,
						null
					).lastInsertRowid
				);
				toolIdRemap.set(toolCodec.parse(t.id), remappedToolId);
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
			for (const t of m.toolCalls ?? []) {
				if (t.parentToolCallId) {
					const parent = toolIdRemap.get(toolCodec.parse(t.parentToolCallId));
					if (parent !== undefined) setToolParent.run(parent, toolIdRemap.get(toolCodec.parse(t.id))!);
				}
			}
			for (const e of m.fileEdits ?? []) {
				insertEdit.run(
					newMsgId,
					e.path,
					e.diff,
					ts,
					e.textOffset,
					e.parentToolCallId ? (toolIdRemap.get(toolCodec.parse(e.parentToolCallId)) ?? null) : null
				);
			}
			for (const r of m.reasoningBlocks ?? []) {
				insertReasoning.run(
					newMsgId,
					r.segmentIndex,
					// Fork reads the transcript untrimmed, so `text` is always
					// present; `?? ''` only satisfies the NOT NULL column typing.
					r.text ?? '',
					r.kind ?? 'reasoning',
					r.textOffset,
					r.startedAt,
					r.durationMs,
					r.parentToolCallId ? (toolIdRemap.get(toolCodec.parse(r.parentToolCallId)) ?? null) : null
				);
			}
		});
	});
	tx();
	return messageIdMap;
}
