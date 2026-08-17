import { error, json } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { conversationId as convCodec } from "$lib/ids";
import * as convs from "$lib/server/db/repos/conversations";
import * as pool from "$lib/server/runtime/pool";
import { getTurn } from "$lib/server/runtime/turn-runner";
import { authorizeConversation } from "$lib/server/conversation-auth";
import { parseBody } from "$lib/server/validate";
import { resolveModelSelection } from "$lib/server/pi/complete";
import { APPROVAL_MODES, SESSION_MODES } from "$lib/types";
import {
  PORTAL_TOOL_GROUP_IDS,
  sanitizeDisabledToolGroups,
} from "$lib/tools/groups";

// PATCH /api/conversations/:id/session — flip per-conversation SDK settings.
//
// Persists to the conversations row so a future open() picks them up. Model,
// memory, and tool-group changes additionally release the pooled session so
// the next turn opens fresh with the new values (the pi runtime has no live
// set-model / set-tools RPC). Mode and approval-mode are settled portal-side
// and read from the row at every turn start.

const PatchBody = z
  .object({
    model: z.string().trim().min(1).optional(),
    mode: z.enum(SESSION_MODES).optional(),
    memoryMode: z
      .enum(["off", "lightweight", "project", "story", "strict"])
      .optional(),
    memoryExtractorModel: z
      .string()
      .trim()
      .transform((value) => (value ? value : null))
      .nullable()
      .optional(),
    adversaryModel: z
      .string()
      .trim()
      .transform((value) => (value ? value : null))
      .nullable()
      .optional(),
    globalMemoryEnabled: z.boolean().optional(),
    approvalMode: z.enum(APPROVAL_MODES).optional(),
    disabledToolGroups: z
      .array(z.enum(PORTAL_TOOL_GROUP_IDS as unknown as [string, ...string[]]))
      .optional(),
  })
  .refine(
    (b) =>
      b.model !== undefined ||
      b.mode !== undefined ||
      b.memoryMode !== undefined ||
      b.memoryExtractorModel !== undefined ||
      b.adversaryModel !== undefined ||
      b.globalMemoryEnabled !== undefined ||
      b.approvalMode !== undefined ||
      b.disabledToolGroups !== undefined,
    {
      message: "No fields to update",
    },
  );

export const PATCH: RequestHandler = async ({ params, locals, request }) => {
  const conv = authorizeConversation(params.id, locals.userId);
  const convId = convCodec.parse(conv.id);
  const body = await parseBody(request, PatchBody);
  // Fail fast on an unselectable model instead of silently falling back to
  // PI_MODEL on the next turn: the string must parse as `providerId/modelId`
  // and resolve against the shared ModelRuntime (the same path the pi session
  // uses at open time).
  if (body.model !== undefined) {
    try {
      await resolveModelSelection(body.model);
    } catch (err) {
      throw error(
        400,
        err instanceof Error ? err.message : `invalid model id: ${body.model}`,
      );
    }
  }
  const modelChanged = body.model !== undefined && body.model !== conv.model;
  const memoryChanged =
    body.memoryMode !== undefined && body.memoryMode !== conv.memoryMode;
  const extractorModelChanged =
    body.memoryExtractorModel !== undefined &&
    body.memoryExtractorModel !== conv.memoryExtractorModel;
  // Captured at session open, so a change only takes effect once the pooled
  // session is released — hence it joins the same guard/release set as the
  // harvester model rather than silently appearing to apply.
  const adversaryModelChanged =
    body.adversaryModel !== undefined &&
    body.adversaryModel !== conv.adversaryModel;
  const globalMemoryChanged =
    body.globalMemoryEnabled !== undefined &&
    body.globalMemoryEnabled !== conv.globalMemoryEnabled;
  const toolGroupsChanged =
    body.disabledToolGroups !== undefined &&
    !sameGroupSet(
      sanitizeDisabledToolGroups(body.disabledToolGroups),
      conv.disabledToolGroups,
    );
  const turn = getTurn(convId);
  if (
    (modelChanged ||
      memoryChanged ||
      extractorModelChanged ||
      adversaryModelChanged ||
      globalMemoryChanged ||
      toolGroupsChanged) &&
    turn?.status === "running"
  ) {
    throw error(
      409,
      "Cannot change model, memory mode, harvester model, adversary model, global memory, or tool groups while a turn is running.",
    );
  }

  const persistedPatch = {
    ...(body.model !== undefined ? { model: body.model } : {}),
    ...(body.mode !== undefined ? { mode: body.mode } : {}),
    ...(body.memoryMode !== undefined ? { memoryMode: body.memoryMode } : {}),
    ...(body.memoryExtractorModel !== undefined
      ? { memoryExtractorModel: body.memoryExtractorModel }
      : {}),
    ...(body.adversaryModel !== undefined
      ? { adversaryModel: body.adversaryModel }
      : {}),
    ...(body.globalMemoryEnabled !== undefined
      ? { globalMemoryEnabled: body.globalMemoryEnabled }
      : {}),
    ...(body.approvalMode !== undefined
      ? { approvalMode: body.approvalMode }
      : {}),
    ...(body.disabledToolGroups !== undefined
      ? { disabledToolGroups: body.disabledToolGroups }
      : {}),
  };
  convs.updateSessionSettings(convId, conv.userId, persistedPatch);
  if (
    modelChanged ||
    memoryChanged ||
    extractorModelChanged ||
    adversaryModelChanged ||
    globalMemoryChanged ||
    toolGroupsChanged
  ) {
    // Portal tools are fixed at session open — there is no live RPC to swap
    // them — so releasing the pooled session is the mechanism that makes the
    // next turn reopen with the filtered tool set.
    await pool.release(convId);
  }

  return json({
    ok: true,
    conversation: convs.get(convId, conv.userId),
  });
};

// POST /api/conversations/:id/session — clear the SDK's session-scoped
// approvals. The pi runtime settles approvals portal-side per request (no
// provider approval cache), so this is a no-op kept for API compatibility.
export const POST: RequestHandler = async ({ params, locals }) => {
  authorizeConversation(params.id, locals.userId);
  return json({ ok: true, supported: false });
};

// Order-insensitive equality for two disabled-group id lists (already
// sanitized). Used to decide whether a tool-group change actually mutated the
// set and therefore requires a session recreate.
function sameGroupSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}
