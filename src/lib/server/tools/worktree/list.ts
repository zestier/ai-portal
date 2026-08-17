import { z } from "zod";
import { inspectLease, leaseIntegrationStatus, listLeases } from "../../leases";
import { err, ok, type PortalTool } from "../types";
import { project, withOmitted, FieldsArg, FIELDS_PARAM } from "../project";
import * as convs from "../../db/repos/conversations";
import { LEASE_KEEP, leaseView } from "./common";

export const ListArgs = z.object({ fields: FieldsArg }).strict();

export function buildWorktreeListTool(ctx: {
  userId: number;
  conversationId: number;
}): PortalTool {
  // Re-read the conversation per call rather than capturing it: a lease may be
  // created many turns after the session was established.
  const conversation = () => convs.get(ctx.conversationId, ctx.userId);
  return {
    name: "worktree_list",
    description:
      "List the PORTAL worktree leases this conversation currently holds.",
    promptGuidelines: [
      "Unlike the git-level `git_worktree_list`, this only sees leases this conversation created. `dirtyCount` is uncommitted files; `ahead` is committed work waiting to be merged back.",
    ],
    argsSchema: ListArgs,
    parameters: {
      type: "object",
      properties: { fields: FIELDS_PARAM },
      additionalProperties: false,
    },
    async handler(args) {
      const parsed = ListArgs.parse(args);
      const conv = conversation();
      // Without the conversation there is no counterpart to measure against,
      // so every row would report unknown counts. Fail loudly instead —
      // matching worktree_create — rather than returning a listing whose
      // numbers are all missing for a reason the model cannot see.
      if (!conv)
        return err("conversation not found", {
          code: "conversation_not_found",
        });
      const leases = listLeases(ctx.conversationId, ctx.userId);
      const views = [];
      for (const lease of leases) {
        // A checkout that has gone missing should not fail the whole listing —
        // report it as unavailable so the agent can still act on the rest.
        let dirtyCount: number | null;
        let counts: { ahead: number; behind: number } | undefined;
        try {
          ({ dirtyCount } = await inspectLease(lease));
          const status = await leaseIntegrationStatus(lease, conv);
          counts = { ahead: status.ahead, behind: status.behind };
        } catch {
          dirtyCount = null;
          counts = undefined;
        }
        views.push(leaseView(lease, dirtyCount, counts));
      }
      const projected = project(views, {
        keep: [...LEASE_KEEP],
        ...(parsed.fields ? { fields: parsed.fields } : {}),
      });
      return ok(
        withOmitted({ worktrees: projected.value }, projected.omitted),
        `${views.length} worktree(s)`,
      );
    },
  };
}
