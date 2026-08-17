import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { conversationId as convCodec } from "$lib/ids";
import { getTurnById } from "$lib/server/runtime/turn-runner";
import { authorizeConversation } from "$lib/server/conversation-auth";

/**
 * Explicit user-initiated cancel of an in-flight turn.
 *
 * Lives at `/turns/[turnId]` (not `/turns/[turnId]/stream`) because
 * cancelling is an operation on the turn resource itself, not on its
 * SSE stream representation. Closing the EventSource alone would only
 * detach this client — the turn would keep running upstream until it
 * completed naturally.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
  const conv = authorizeConversation(params.id, locals.userId);

  const turn = getTurnById(convCodec.parse(conv.id), params.turnId);
  if (!turn || turn.status !== "running") {
    return json({ ok: true, aborted: false });
  }
  await turn.abort();
  return json({ ok: true, aborted: true });
};
