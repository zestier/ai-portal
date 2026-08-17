import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { conversationId as convCodec } from "$lib/ids";
import * as convs from "$lib/server/db/repos/conversations";
import { authorizeConversation } from "$lib/server/conversation-auth";

/**
 * List forks (child conversations) that were created from this one.
 *
 * Returned items include the source message id, so the client can render
 * a "Forked → …" badge next to the exact message that produced each
 * fork.
 */
export const GET: RequestHandler = ({ params, locals }) => {
  const source = authorizeConversation(params.id, locals.userId);
  const children = convs.listChildren(
    source.userId,
    convCodec.parse(source.id),
  );
  return json({
    forks: children.map((c) => ({
      id: c.id,
      title: c.title,
      sourceMessageId: c.forkedFromMessageId,
      createdAt: c.createdAt,
      archivedAt: c.archivedAt,
    })),
  });
};
