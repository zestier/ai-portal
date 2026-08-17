import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
  authorizeConversationWorkspace,
  leaseIdFromUrl,
} from "$lib/server/conversation-auth";
import { discardAllLocalChanges, GitError } from "$lib/server/git";

/**
 * Discard all uncommitted changes in the selected workspace.
 *
 * This MUST honor the same `?worktree=` selector the read endpoints use. The
 * Changes view can be pointed at a lease, and a revert that silently targeted
 * the conversation's own tree instead would destroy work the user was not
 * looking at while leaving the work they *were* looking at untouched.
 */
export const POST: RequestHandler = async ({ params, locals, url }) => {
  const { workdir } = authorizeConversationWorkspace(
    params.id,
    locals.userId,
    leaseIdFromUrl(url),
  );
  try {
    await discardAllLocalChanges(workdir);
    return json({ ok: true });
  } catch (e) {
    if (e instanceof GitError) throw error(400, e.message);
    throw e;
  }
};
