import { error, json } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { conversationId as convCodec, messageId as msgCodec } from "$lib/ids";
import {
  editAssistantMessage,
  InlineEditRejected,
} from "$lib/server/message-edit";
import { parseBody } from "$lib/server/validate";
import { authorizeConversation } from "$lib/server/conversation-auth";

const Body = z.object({ content: z.string().trim().min(1).max(64_000) });

const REJECT_STATUS: Record<string, number> = {
  conversation_not_found: 404,
  message_not_found: 404,
  not_assistant_message: 400,
  content_required: 400,
  conversation_busy: 409,
};

export const POST: RequestHandler = async ({ params, locals, request }) => {
  authorizeConversation(params.id, locals.userId);
  const userId = locals.userId;
  const { content } = await parseBody(request, Body);

  const conversationId = convCodec.tryParse(params.id);
  const messageId = msgCodec.tryParse(params.messageId);
  if (conversationId === null) throw error(404);
  if (messageId === null) throw error(400, "missing message id");

  try {
    editAssistantMessage({
      userId,
      conversationId,
      messageId,
      newContent: content,
    });
    return json({ ok: true });
  } catch (e) {
    if (e instanceof InlineEditRejected) {
      throw error(REJECT_STATUS[e.reason] ?? 400, e.message);
    }
    throw e;
  }
};
