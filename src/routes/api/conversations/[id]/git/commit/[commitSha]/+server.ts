import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
  authorizeConversationWorkspace,
  leaseIdFromUrl,
} from "$lib/server/conversation-auth";
import { showCommit, GitError } from "$lib/server/git";

export const GET: RequestHandler = async ({ params, locals, url }) => {
  const { workdir } = authorizeConversationWorkspace(
    params.id,
    locals.userId,
    leaseIdFromUrl(url),
  );
  const sha = params.commitSha;
  if (!sha) throw error(400, "commitSha required");
  try {
    const commit = await showCommit(workdir, sha);
    return json({ commit });
  } catch (e) {
    if (e instanceof GitError) throw error(404, e.message);
    throw e;
  }
};
