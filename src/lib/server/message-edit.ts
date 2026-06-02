import * as convs from '$lib/server/db/repos/conversations';
import * as memoryRepo from '$lib/server/db/repos/memory';
import * as messages from '$lib/server/db/repos/messages';
import * as usage from '$lib/server/db/repos/usage';
import { getTurn } from '$lib/server/runtime/turn-runner';
import { cancelConversation as cancelPendingInteractive } from '$lib/server/runtime/interactive-requests';
import type { Conversation, Message } from '$lib/types';

export type InlineEditError =
	| 'conversation_not_found'
	| 'message_not_found'
	| 'not_user_message'
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

	const conv = convs.get(input.conversationId, input.userId);
	if (!conv) throw new InlineEditRejected('conversation_not_found');

	const active = getTurn(conv.id);
	if (active && active.status === 'running') {
		throw new InlineEditRejected('conversation_busy', 'Conversation has a running turn.');
	}

	const all = messages.listByConversation(conv.id);
	const targetIdx = all.findIndex((m) => m.id === input.messageId);
	const target = targetIdx >= 0 ? all[targetIdx] : null;
	if (!target) throw new InlineEditRejected('message_not_found');
	if (target.role !== 'user') {
		throw new InlineEditRejected('not_user_message', 'Only user messages can be edited inline.');
	}

	cancelPendingInteractive(conv.id, 'message_inline_edit');
	memoryRepo.rewindSessionMemoryLogToMessagePrefix(conv.id, {
		messageIds: new Set(all.slice(0, targetIdx + 1).map((message) => message.id)),
		createdBefore: all[targetIdx + 1]?.createdAt
	});
	const userMessage = messages.truncateAfterAndUpdateUserMessage(
		conv.id,
		target.id,
		input.newContent
	);
	if (!userMessage) throw new InlineEditRejected('message_not_found');
	usage.remove(conv.id);
	const providerSessionId = convs.rotateProviderSession(conv.id, input.userId);
	if (!providerSessionId) throw new InlineEditRejected('conversation_not_found');

	const refreshed = convs.get(conv.id, input.userId);
	if (!refreshed) throw new InlineEditRejected('conversation_not_found');
	return { conversation: refreshed, userMessage };
}
