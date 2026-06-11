import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorizeConversation } from '$lib/server/conversation-auth';
import * as memory from '$lib/server/db/repos/memory';
import * as messages from '$lib/server/db/repos/messages';
import * as turnInputs from '$lib/server/db/repos/turn-inputs';
import { isEnabled } from '$lib/server/memory/engine';
import { getTurn, startExtractionRetryTurn } from '$lib/server/runtime/turn-runner';

export const GET: RequestHandler = async ({ params, locals }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	return json({ memory: memory.listSnapshot(conv.id, { userId: conv.userId }) });
};

/**
 * Retry memory extraction for the *latest* turn (extraction-only).
 *
 * Reuses the stored user + assistant messages, re-runs `extractAndCommitMemory`
 * using the conversation's configured extractor model, and — only once that
 * produces a *committable* (validated) patch — reverts the latest turn's prior
 * committed patch (if any) immediately before the replacement is applied. A
 * failed, timed-out, aborted, or `needs_review` retry therefore preserves the
 * existing memory. The assistant response is NOT regenerated and no new
 * message/turn is created.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	const conv = authorizeConversation(params.id, locals.userId);

	if (!isEnabled(conv.memoryMode)) {
		throw error(400, 'Memory is disabled for this conversation; nothing to re-extract.');
	}

	// Block while a turn (or its extraction) is running — consistent with the
	// failed-tool rerun endpoint. `startExtractionRetryTurn` also registers a
	// running turn, so this likewise guards a second retry in flight.
	const current = getTurn(conv.id);
	if (current && current.status === 'running') {
		throw error(409, 'A turn is already in progress for this conversation.');
	}

	// Resolve the latest turn server-side: the most recent assistant message
	// and the user message that triggered it.
	const allMessages = messages.listByConversation(conv.id);
	let assistantIdx = -1;
	for (let i = allMessages.length - 1; i >= 0; i--) {
		if (allMessages[i].role === 'assistant') {
			assistantIdx = i;
			break;
		}
	}
	if (assistantIdx < 0) {
		throw error(400, 'There is no assistant turn to re-extract.');
	}
	const assistantMessage = allMessages[assistantIdx];
	let userMessage: (typeof allMessages)[number] | null = null;
	for (let i = assistantIdx - 1; i >= 0; i--) {
		if (allMessages[i].role === 'user') {
			userMessage = allMessages[i];
			break;
		}
	}
	if (!userMessage) {
		throw error(400, 'Could not resolve the user message for the latest turn.');
	}

	// The stable turn id for the latest turn (recorded against its triggering
	// user message). Committed patches — original and any prior retries — are
	// grouped under it, so revert can find the prior patch across repeated
	// retries even though each retry runs under a fresh streaming turn.
	const latestTurnId = turnInputs.get(conv.id, userMessage.id)?.turnId ?? null;

	// Identify the prior committed patch to revert. The revert itself is
	// deferred into the retry turn and applied only once re-extraction produces
	// a committable patch (see `startExtractionRetryTurn`), so a failed retry
	// never destroys the existing memory. Skip when the prior extraction
	// committed nothing (failed / needs_review / already reverted).
	const patches = memory.listPatches(conv.id, { limit: 50 });
	const isCommitted = (status: string) =>
		status === 'committed' || status === 'partially_committed';
	// Only revert when we can pin the patch to *this* turn via its stable turn
	// id. Without a recorded turn id (legacy/stub turns) we deliberately do NOT
	// fall back to "the most recent committed patch": that patch may belong to an
	// earlier turn (e.g. the latest turn committed nothing), and reverting it
	// would destroy unrelated memory. Skipping the revert at worst leaves a stale
	// patch alongside the replacement — far safer than clobbering another turn.
	const priorPatch = latestTurnId
		? patches.find((p) => p.turnId === latestTurnId && isCommitted(p.status))
		: undefined;

	const turn = await startExtractionRetryTurn({
		conversationId: conv.id,
		userId: conv.userId,
		assistantMessageId: assistantMessage.id,
		assistantContent: assistantMessage.content,
		memory: {
			mode: conv.memoryMode,
			userMessageId: userMessage.id,
			userContent: userMessage.content,
			extractorModel: conv.memoryExtractorModel,
			patchTurnId: latestTurnId,
			revertPatchId: priorPatch?.id ?? null
		}
	});

	return json({
		turnId: turn.id,
		assistantMessageId: assistantMessage.id,
		// The patch slated for revert; the revert is applied only if/when the
		// retry's re-extraction succeeds.
		revertPatchId: priorPatch?.id ?? null
	});
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	memory.wipe(conv.id);
	return json({ ok: true, memory: memory.listSnapshot(conv.id, { userId: conv.userId }) });
};
