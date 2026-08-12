// Publisher for the sidebar's "active" signal (see `AppEvent.activity.changed`).
//
// A conversation is active when a turn is running for it OR it carries
// assistant output the user hasn't seen. The two halves live in different
// places — `running` is in-process turn-registry state, `unread` is a DB
// comparison — so this module joins them into the single full-snapshot event
// the sidebar consumes.
//
// `running` is passed in rather than read from the turn registry on purpose:
// `turn-runner` is the main emitter, and importing it here would create a
// module cycle. Callers that aren't the turn runner resolve it via `getTurn`.

import { publishAppEvent } from './app-events';
import * as convs from '../db/repos/conversations';
import { log } from '../log';

/**
 * Publish a conversation's current active state to its owner's global feed.
 *
 * Best-effort by design: this is a UI nicety layered over the authoritative
 * layout `load`, so a feed or DB hiccup must never break the turn or request
 * that triggered it.
 */
export function publishConversationActivity(
	userId: number | undefined,
	conversationId: number,
	running: boolean
): void {
	if (!userId) return;
	try {
		publishAppEvent(userId, {
			type: 'activity.changed',
			conversationId,
			running,
			unread: convs.hasUnread(conversationId, userId)
		});
	} catch (err) {
		log.warn('activity.publish_failed', {
			conversationId,
			err: err instanceof Error ? err.message : String(err)
		});
	}
}
