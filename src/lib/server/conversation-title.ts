import type { Conversation, Message } from '$lib/types';
import { conversationId as convCodec } from '$lib/ids';
import * as convs from '$lib/server/db/repos/conversations';
import * as messages from '$lib/server/db/repos/messages';
import { log } from '$lib/server/log';
import { deriveTitle, isDefaultTitle } from '$lib/server/title';

export function tryRenameFromFirstUserMessage(conv: Conversation, userMsg: Message): string | null {
	try {
		if (userMsg.role !== 'user' || !userMsg.content.trim()) return null;

		const latest = convs.get(convCodec.parse(conv.id), conv.userId);
		if (!latest || !isDefaultTitle(latest.title)) return null;

		const nonEmptyUserMessages = messages
			.listByConversation(convCodec.parse(conv.id))
			.filter((m) => m.role === 'user' && m.content.trim());
		if (nonEmptyUserMessages.length !== 1 || nonEmptyUserMessages[0].id !== userMsg.id) {
			return null;
		}

		const newTitle = deriveTitle(userMsg.content);
		if (isDefaultTitle(newTitle) || newTitle === latest.title) return null;

		const renamed = convs.renameIfDefault(convCodec.parse(conv.id), conv.userId, newTitle);
		if (!renamed) {
			log.warn('conversation.autotitle.skipped', {
				conversationId: conv.id,
				messageId: userMsg.id
			});
			return null;
		}
		return newTitle;
	} catch (e) {
		log.warn('conversation.autotitle.failed', {
			conversationId: conv.id,
			messageId: userMsg.id,
			err: String(e)
		});
		return null;
	}
}
