import { getDb } from '$lib/server/db';
import * as convs from '$lib/server/db/repos/conversations';
import * as memoryRepo from '$lib/server/db/repos/memory';
import * as messages from '$lib/server/db/repos/messages';
import * as usage from '$lib/server/db/repos/usage';
import { getTurn } from '$lib/server/runtime/turn-runner';
import { cancelConversation as cancelPendingInteractive } from '$lib/server/runtime/interactive-requests';
import { resolveConversationWorkspace } from '$lib/server/workdir';
import type { Conversation, Message } from '$lib/types';

export type InlineEditError =
	| 'conversation_not_found'
	| 'message_not_found'
	| 'not_user_message'
	| 'not_assistant_message'
	| 'no_user_message'
	| 'content_required'
	| 'conversation_busy';

export class InlineEditRejected extends Error {
	constructor(
		public readonly reason: InlineEditError,
		msg?: string
	) {
		super(msg ?? reason);
		this.name = 'InlineEditRejected';
	}
}

export interface InlineEditInput {
	userId: string;
	conversationId: string;
	messageId: string;
	newContent: string;
}

export interface InlineEditResult {
	conversation: Conversation;
	userMessage: Message;
}

export function inlineEditMessage(input: InlineEditInput): InlineEditResult {
	if (!input.newContent) {
		throw new InlineEditRejected('content_required', 'content is required.');
	}

	const { conv, all } = loadIdleConversation(input.userId, input.conversationId);
	const targetIdx = all.findIndex((m) => m.id === input.messageId);
	const target = targetIdx >= 0 ? all[targetIdx] : null;
	if (!target) throw new InlineEditRejected('message_not_found');
	if (target.role !== 'user') {
		throw new InlineEditRejected('not_user_message', 'Only user messages can be edited inline.');
	}

	return rerunFromUserMessage(
		input.userId,
		conv,
		all,
		target,
		input.newContent,
		'message_inline_edit'
	);
}

export interface RegenerateInput {
	userId: string;
	conversationId: string;
	messageId: string;
}

/**
 * Regenerate a completed assistant message in place. The assistant reply (and
 * everything after it) is discarded and the turn is re-run from the unchanged
 * preceding user message, producing a fresh response. Mechanically this is an
 * inline edit of that user message with its content left untouched.
 */
export function regenerateFromAssistant(input: RegenerateInput): InlineEditResult {
	const { conv, all } = loadIdleConversation(input.userId, input.conversationId);
	const targetIdx = all.findIndex((m) => m.id === input.messageId);
	const target = targetIdx >= 0 ? all[targetIdx] : null;
	if (!target) throw new InlineEditRejected('message_not_found');
	if (target.role !== 'assistant') {
		throw new InlineEditRejected(
			'not_assistant_message',
			'Only assistant messages can be regenerated.'
		);
	}

	// Walk back to the nearest preceding user message that initiated this turn.
	let userIdx = -1;
	for (let i = targetIdx - 1; i >= 0; i--) {
		if (all[i].role === 'user') {
			userIdx = i;
			break;
		}
	}
	if (userIdx < 0) {
		throw new InlineEditRejected(
			'no_user_message',
			'No preceding user message to regenerate from.'
		);
	}
	const userMsg = all[userIdx];

	return rerunFromUserMessage(
		input.userId,
		conv,
		all,
		userMsg,
		userMsg.content,
		'message_regenerate'
	);
}

function loadIdleConversation(
	userId: string,
	conversationId: string
): { conv: Conversation; all: Message[] } {
	const conv = convs.get(conversationId, userId);
	if (!conv) throw new InlineEditRejected('conversation_not_found');

	const active = getTurn(conv.id);
	if (active && active.status === 'running') {
		throw new InlineEditRejected('conversation_busy', 'Conversation has a running turn.');
	}

	const all = messages.listByConversation(conv.id);
	return { conv, all };
}

/**
 * Shared core for inline edit and regenerate: cancel pending interactive
 * prompts, rewind session memory to the user-message prefix, truncate the
 * conversation after the user message (updating its content), clear usage, and
 * rotate the provider session so the backend produces an independent reply.
 */
function rerunFromUserMessage(
	userId: string,
	conv: Conversation,
	all: Message[],
	userMessage: Message,
	content: string,
	cancelReason: string
): InlineEditResult {
	const targetIdx = all.findIndex((m) => m.id === userMessage.id);
	resolveConversationWorkspace(conv);

	cancelPendingInteractive(conv.id, cancelReason);
	const updated = getDb().transaction(() => {
		memoryRepo.rewindSessionMemoryLogToMessagePrefix(conv.id, {
			messageIds: new Set(all.slice(0, targetIdx + 1).map((message) => message.id)),
			createdBefore: all[targetIdx + 1]?.createdAt
		});
		const updatedMessage = messages.truncateAfterAndUpdateUserMessage(
			conv.id,
			userMessage.id,
			content
		);
		if (!updatedMessage) throw new InlineEditRejected('message_not_found');
		usage.remove(conv.id);
		const providerSessionId = convs.rotateProviderSession(conv.id, userId);
		if (!providerSessionId) throw new InlineEditRejected('conversation_not_found');
		return updatedMessage;
	})();

	const refreshed = convs.get(conv.id, userId);
	if (!refreshed) throw new InlineEditRejected('conversation_not_found');
	return { conversation: refreshed, userMessage: updated };
}
