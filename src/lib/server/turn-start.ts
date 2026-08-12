import * as convs from '$lib/server/db/repos/conversations';
import * as messages from '$lib/server/db/repos/messages';
import * as settings from '$lib/server/db/repos/settings';
import * as pool from '$lib/server/runtime/pool';
import { loadConfig } from '$lib/server/config';
import { startTurn } from '$lib/server/runtime/turn-runner';
import { snapshot as takeSnapshot } from '$lib/server/snapshots';
import { resolveConversationWorkspace } from '$lib/server/workdir';
import { log } from '$lib/server/log';
import { buildPromptWithMemory, isEnabled } from '$lib/server/memory/engine';
import { isModelBackedExtractorConfigured } from '$lib/server/memory/extractor';
import type { Conversation, Message, PortalEvent } from '$lib/types';

export interface StartTurnFromUserMessageOptions {
	/**
	 * True for an edit/regenerate/fork rerun: the turn rewinds the persistent pi
	 * session to the target user message and re-runs from it, matching the
	 * SQLite truncation. False for a normal continuation.
	 */
	rerun?: boolean;
	initialEvents?: PortalEvent[];
}

export async function startTurnFromUserMessage(
	conv: Conversation,
	userMsg: Message,
	opts: StartTurnFromUserMessageOptions = {}
) {
	const workdir = resolveConversationWorkspace(conv);

	const cfg = loadConfig();
	const userSettings = settings.get(conv.userId) ?? settings.defaults();
	const memoryEnabled = isEnabled(conv.memoryMode);
	if (memoryEnabled) {
		// A memory-backed turn rebuilds the session's prompt from portal state,
		// so any prior session is released to avoid stale context leaking in.
		await pool.release(conv.id);
	}
	const prompt = memoryEnabled
		? buildPromptWithMemory({
				conversationId: conv.id,
				mode: conv.memoryMode,
				userMsg,
				userId: conv.userId,
				globalMemoryEnabled: conv.globalMemoryEnabled,
				includeRecentTranscript: true,
				extractorPresent: isModelBackedExtractorConfigured({
					model: conv.memoryExtractorModel
				})
			})
		: userMsg.content;
	const rerun = opts.rerun === true;
	const rewindToUserMessageOrdinal =
		rerun && !memoryEnabled ? userMessageOrdinal(conv.id, userMsg.id) : undefined;
	const turn = await startTurn({
		conversationId: conv.id,
		prompt,
		userMessageId: userMsg.id,
		bridge: {
			conversationId: conv.id,
			userId: conv.userId,
			workingDirectory: workdir,
			workspaceKey: conv.workspaceKey,
			model: conv.model ?? cfg.DEFAULT_MODEL,
			policy: userSettings.defaultPolicy,
			mode: conv.mode,
			approvalMode: conv.approvalMode,
			disabledToolGroups: conv.disabledToolGroups,
			memoryMode: conv.memoryMode,
			globalMemoryEnabled: conv.globalMemoryEnabled,
			// Persistent pi session: resume the conversation's file, or create one
			// on its first turn. Memory-mode turns stay in-memory (the session is
			// released above and rebuilt from portal memory each turn).
			...(memoryEnabled ? {} : { sessionFilePath: conv.sessionFile ?? null }),
			...(rewindToUserMessageOrdinal !== undefined ? { rewindToUserMessageOrdinal } : {})
		},
		initialEvents: opts.initialEvents,
		memory: memoryEnabled
			? {
					mode: conv.memoryMode,
					userMessageId: userMsg.id,
					userContent: userMsg.content,
					extractorModel: conv.memoryExtractorModel
				}
			: undefined,
		beforeSend: async () => {
			try {
				await takeSnapshot(workdir, userMsg.id, 'pre');
			} catch (e) {
				log.warn('snapshot.pre.failed', {
					conversationId: conv.id,
					messageId: userMsg.id,
					err: String(e)
				});
			}
		}
	});
	convs.touch(conv.id);
	return turn;
}

/**
 * 0-based index of `userMessageId` among the conversation's user messages
 * (oldest first). The edit/regenerate/fork rerun rewinds the persistent pi tree
 * to this entry. Returns undefined when the message can't be located — the turn
 * then runs without a rewind (a fresh/legacy conversation with no tree yet).
 */
function userMessageOrdinal(conversationId: string, userMessageId: string): number | undefined {
	const all = messages.listByConversation(conversationId);
	const idx = all.findIndex((m) => m.id === userMessageId);
	if (idx < 0) return undefined;
	let ordinal = -1;
	for (let i = 0; i <= idx; i++) {
		if (all[i].role === 'user') ordinal++;
	}
	return ordinal >= 0 ? ordinal : undefined;
}
