import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { conversationId as convCodec, messageId as msgCodec } from "$lib/ids";
import {
  regenerateFromAssistant,
  InlineEditRejected,
} from "$lib/server/message-edit";
import { startTurnFromUserMessage } from "$lib/server/turn-start";
import { authorizeConversation } from "$lib/server/conversation-auth";
import { throwRerunFailure } from "$lib/server/rerun-error";
import {
  TurnAlreadyInProgressError,
  releaseTurnReservation,
  reserveTurn,
} from "$lib/server/runtime/turn-runner";

const REJECT_STATUS: Record<string, number> = {
  conversation_not_found: 404,
  message_not_found: 404,
  not_assistant_message: 400,
  no_user_message: 400,
  conversation_busy: 409,
};

/**
 * Regenerate a completed assistant message in place. Discards that reply (and
 * anything after it) and re-runs the turn from the unchanged preceding user
 * message, streaming a fresh response in the same conversation.
 *
 * Returns `{ turnId, userMessageId }` so the client can truncate its rendered
 * thread to the preceding user message and reattach to the new turn's stream,
 * symmetrically with the inline-edit flow.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
  authorizeConversation(params.id, locals.userId);
  const userId = locals.userId;

  const conversationId = convCodec.tryParse(params.id);
  const messageId = msgCodec.tryParse(params.messageId);
  if (conversationId === null) throw error(404);
  if (messageId === null) throw error(400, "missing message id");

  // Claim the turn slot synchronously to close the same memory-mode race as
  // the inline-edit route: a plain `getTurn` busy-check leaves a window where
  // two concurrent reruns both pass and race into `startTurn`. The loser is
  // rejected here as a clean 409 instead of a 502.
  try {
    reserveTurn(conversationId);
  } catch (e) {
    if (e instanceof TurnAlreadyInProgressError) {
      throw error(409, "A turn is already in progress for this conversation.");
    }
    throw e;
  }

  try {
    const { conversation, userMessage } = regenerateFromAssistant({
      userId,
      conversationId,
      messageId,
    });
    const turn = await startTurnFromUserMessage(conversation, userMessage, {
      rerun: true,
    });
    return json({ ok: true, turnId: turn.id, userMessageId: userMessage.id });
  } catch (e) {
    if (e instanceof InlineEditRejected) {
      throw error(REJECT_STATUS[e.reason] ?? 400, e.message);
    }
    throwRerunFailure(
      {
        route: "message_regenerate",
        conversationId: String(conversationId),
        userId: String(userId),
      },
      e,
    );
  } finally {
    releaseTurnReservation(conversationId);
  }
};
