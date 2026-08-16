import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { conversationId as convCodec, messageId as msgCodec } from '$lib/ids';
import { forkAtMessage, ForkRejected } from '$lib/server/fork';
import { startTurnFromUserMessage } from '$lib/server/turn-start';
import { parseBody } from '$lib/server/validate';
import { throwRerunFailure } from '$lib/server/rerun-error';
import * as convs from '$lib/server/db/repos/conversations';
import * as pool from '$lib/server/runtime/pool';
import { getTurn } from '$lib/server/runtime/turn-runner';
import { rollbackManagedWorktree } from '$lib/server/worktrees';
import { log } from '$lib/server/log';

// `content` present => edit a user message with the new text.
// `content` absent  => retry from an assistant message (uses post snapshot).
const Body = z.object({
	content: z.string().min(1).max(64_000).optional(),
	workspace: z.enum(['shared', 'worktree']).optional()
});

const REJECT_STATUS: Record<string, number> = {
	source_not_found: 404,
	message_not_found: 404,
	not_user_message: 400,
	unsupported_role: 400,
	content_required: 400,
	content_not_allowed: 400,
	no_snapshot: 409
};

/**
 * Fork a conversation from a given message.
 *
 *  - Body `{ content }`  → edit that user message, re-run from there.
 *  - Body `{}`           → retry from that assistant message.
 *
 * Returns `{ conversationId }` of the new fork. The client should
 * navigate to it to continue. When the source has a running turn an
 * edit-fork is created without auto-starting its turn; the response carries
 * `{ deferred: true }`. The edited text is persisted as the new
 * conversation's `draft_prompt` and seeded into its composer on load, so the
 * client just navigates and lets the user press Send.
 */
export const POST: RequestHandler = async ({ params, locals, request }) => {
	const userId = locals.userId;
	const sourceId = convCodec.tryParse(params.id);
	const messageId = msgCodec.tryParse(params.messageId);
	if (sourceId === null) throw error(404);
	if (messageId === null) throw error(400, 'missing message id');
	// Accept an empty body for retry-from-assistant.
	const parsed = await parseBody(request, Body, { allowEmpty: true });

	try {
		const { conversation, userMessage, deferred } = await forkAtMessage({
			userId,
			sourceConversationId: sourceId,
			messageId,
			newContent: parsed.content ?? null,
			workspaceKind: parsed.workspace === 'worktree' ? 'managed-worktree' : 'shared'
		});
		if (!userMessage) {
			return json({ ok: true, conversationId: conversation.id, deferred });
		}
		let turn;
		try {
			turn = await startTurnFromUserMessage(conversation, userMessage, { rerun: true });
		} catch (cause) {
			if (!getTurn(convCodec.parse(conversation.id))) {
				try {
					await pool.release(convCodec.parse(conversation.id));
					const managed = convs.getManagedWorktree(convCodec.parse(conversation.id), userId);
					if (managed) await rollbackManagedWorktree(managed);
					convs.remove(convCodec.parse(conversation.id), userId);
				} catch (cleanupError) {
					log.warn('fork.start_cleanup_failed', {
						conversationId: conversation.id,
						err: String(cleanupError)
					});
				}
			}
			throw cause;
		}
		return json({ ok: true, conversationId: conversation.id, turnId: turn.id });
	} catch (e) {
		if (e instanceof ForkRejected) {
			throw error(REJECT_STATUS[e.reason] ?? 400, e.message);
		}
		throwRerunFailure(
			{ route: 'message_fork', conversationId: String(sourceId), userId: String(userId) },
			e
		);
	}
};
