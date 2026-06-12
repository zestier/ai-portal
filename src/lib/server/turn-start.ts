import * as convs from '$lib/server/db/repos/conversations';
import * as messages from '$lib/server/db/repos/messages';
import * as settings from '$lib/server/db/repos/settings';
import * as pool from '$lib/server/runtime/pool';
import { loadConfig } from '$lib/server/config';
import { startTurn } from '$lib/server/runtime/turn-runner';
import { getProvider } from '$lib/server/providers';
import { providerAuthToken } from '$lib/server/providers/auth';
import { snapshot as takeSnapshot } from '$lib/server/snapshots';
import { effectiveWorkdir } from '$lib/server/workdir';
import { log } from '$lib/server/log';
import { buildPromptWithMemory, isEnabled } from '$lib/server/memory/engine';
import { isModelBackedExtractorConfigured } from '$lib/server/memory/extractor';
import type { Conversation, Message, PortalEvent } from '$lib/types';
import type { ProviderConversationMessage } from '$lib/server/providers/provider';

export interface StartTurnFromUserMessageOptions {
	includePriorMessages?: boolean;
	initialEvents?: PortalEvent[];
}

export async function startTurnFromUserMessage(
	conv: Conversation,
	userMsg: Message,
	opts: StartTurnFromUserMessageOptions = {}
) {
	const workdir = effectiveWorkdir(conv.workdir);

	const cfg = loadConfig();
	const userSettings = settings.get(conv.userId) ?? settings.defaults();
	const provider = getProvider(conv.provider);
	const memoryEnabled = isEnabled(conv.memoryMode);
	let providerSessionId = conv.providerSessionId;
	if (memoryEnabled) {
		await pool.release(conv.id);
		providerSessionId = convs.rotateProviderSession(conv.id, conv.userId) ?? providerSessionId;
	}
	const promptIncludesPriorMessages =
		!memoryEnabled &&
		(opts.includePriorMessages || provider.shouldEmbedPriorMessages?.(providerSessionId) === true);
	const prompt = memoryEnabled
		? buildPromptWithMemory({
				conversationId: conv.id,
				mode: conv.memoryMode,
				userMsg,
				userId: conv.userId,
				globalMemoryEnabled: conv.globalMemoryEnabled,
				includeRecentTranscript: true,
				extractorPresent: isModelBackedExtractorConfigured({
					model: conv.memoryExtractorModel,
					backend: conv.memoryExtractorBackend
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
			providerSessionId,
			userId: conv.userId,
			workingDirectory: workdir,
			provider: conv.provider,
			model: conv.model ?? cfg.DEFAULT_MODEL,
			policy: userSettings.defaultPolicy,
			mode: conv.mode,
			approveAllTools: conv.approveAllTools,
			memoryMode: conv.memoryMode,
			globalMemoryEnabled: conv.globalMemoryEnabled,
			providerAuthToken: providerAuthToken(conv.provider, conv.userId),
			initialMessages:
				!memoryEnabled && !promptIncludesPriorMessages && !provider.capabilities.session.resume
					? buildProviderInitialMessages(conv.id, userMsg)
					: undefined,
			onProviderSessionIdChange: (providerSessionId) => {
				const updated = convs.setProviderSessionId(conv.id, conv.userId, providerSessionId);
				if (!updated) {
					throw new Error(
						`Failed to persist ${conv.provider} provider session id for conversation ${conv.id}: ${providerSessionId}`
					);
				}
			}
		},
		initialEvents: opts.initialEvents,
		memory: memoryEnabled
			? {
					mode: conv.memoryMode,
					userMessageId: userMsg.id,
					userContent: userMsg.content,
					extractorModel: conv.memoryExtractorModel,
					extractorBackend: conv.memoryExtractorBackend
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

export function buildProviderInitialMessages(
	conversationId: string,
	userMsg: Message
): ProviderConversationMessage[] {
	const transcript = messages.listByConversation(conversationId);
	const targetIdx = transcript.findIndex((m) => m.id === userMsg.id);
	if (targetIdx <= 0) return [];
	return transcript
		.slice(0, targetIdx)
		.filter((m) => m.status === 'complete' && (m.content.trim() || (m.toolCalls?.length ?? 0) > 0))
		.map((m) => ({
			role: m.role,
			content: m.content,
			status: m.status,
			toolCalls: m.toolCalls
		}));
}
