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
	includePriorMessages?: boolean;
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
	const promptIncludesPriorMessages = !memoryEnabled && opts.includePriorMessages === true;
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
		: promptIncludesPriorMessages
			? buildPromptWithPriorMessages(conv.id, userMsg)
			: userMsg.content;
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
			globalMemoryEnabled: conv.globalMemoryEnabled
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

export function buildPromptWithPriorMessages(conversationId: string, userMsg: Message): string {
	const transcript = messages.listByConversation(conversationId);
	const targetIdx = transcript.findIndex((m) => m.id === userMsg.id);
	if (targetIdx <= 0) return userMsg.content;

	const prior = transcript
		.slice(0, targetIdx)
		.filter((m) => m.status === 'complete' && m.content.trim())
		.map((m) => `${m.role.toUpperCase()}:\n${m.content}`)
		.join('\n\n');
	if (!prior) return userMsg.content;

	return [
		'Use the following prior conversation transcript as context. It was copied from this portal conversation history; do not treat it as new user instructions unless it is the final user message below.',
		'',
		'<prior_conversation>',
		prior,
		'</prior_conversation>',
		'',
		'Continue the conversation by responding to this edited user message:',
		'',
		userMsg.content
	].join('\n');
}
