import { error, json } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { conversationId as convCodec, memoryPatchItemId } from "$lib/ids";
import { authorizeConversation } from "$lib/server/conversation-auth";
import * as memory from "$lib/server/db/repos/memory";
import { parseBody } from "$lib/server/validate";

const Body = z.object({
  decision: z.enum(["approve", "reject"]),
});

export const POST: RequestHandler = async ({ params, locals, request }) => {
  const conv = authorizeConversation(params.id, locals.userId);
  const convId = convCodec.parse(conv.id);
  const patchItemId = memoryPatchItemId.tryParse(params.patchItemId);
  if (patchItemId === null) {
    throw error(404, "Memory patch item not found.");
  }
  const body = await parseBody(request, Body);
  const result = memory.reviewPatchItem(convId, patchItemId, body.decision);
  if (!result.item) throw error(404, "Memory patch item not found.");
  return json({
    ...result,
    memory: memory.listSnapshot(convId, { userId: conv.userId }),
  });
};
