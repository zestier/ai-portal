import { z } from "zod";
import { commitChanges, repositoryLockKey } from "../../git";
import { withRepositoryLock } from "../../repo-lock";
import { ok, type PortalTool } from "../types";
import {
  createTreeResolver,
  WorktreeSelector,
  WORKTREE_COMMIT_PARAM,
  type WorktreeToolContext,
} from "../worktree-selector";
import {
  CommitBody,
  CommitSubject,
  CommitTrailers,
} from "../commit-message-args";
import {
  COMMIT_TICKET_FOLLOW_UP_HINT,
  leaseIntegrateFollowUpHint,
  WORKTREE_INTEGRATE_FOLLOW_UP_HINT,
} from "../follow-up-hints";
import { isLinkedWorktree } from "./common";

export const GitCommitArgs = z
  .object({
    paths: z.union([
      z.literal("all"),
      z.array(z.string().min(1).max(4096)).min(1),
    ]),
    subject: CommitSubject,
    body: CommitBody,
    trailers: CommitTrailers,
    worktree: WorktreeSelector,
    allowConflictMarkers: z.boolean().optional(),
  })
  .strict();

export function buildGitCommitTools(
  cwd: string,
  ctx?: WorktreeToolContext,
): PortalTool[] {
  const treeFor = createTreeResolver(cwd, ctx);
  return [
    {
      name: "git_commit",
      description:
        'Create a commit from a structured message over `paths: "all"` or named file paths; also concludes an in-progress merge.',
      argsSchema: GitCommitArgs,
      permissionBehavior: "always-prompt",
      parameters: {
        type: "object",
        properties: {
          paths: {
            oneOf: [
              { type: "string", enum: ["all"] },
              {
                type: "array",
                items: { type: "string" },
                minItems: 1,
                description:
                  "Workspace-relative paths; untracked files included only when named.",
              },
            ],
            description:
              "`all` (all current changes; mid-merge, the conflicted resolutions) or an array of workspace-relative file paths.",
          },
          subject: {
            type: "string",
            description: "Required subject.",
          },
          body: {
            type: "string",
            description: "Optional body.",
          },
          trailers: {
            type: "array",
            items: {
              type: "object",
              properties: {
                token: { type: "string" },
                value: { type: "string" },
              },
              required: ["token", "value"],
              additionalProperties: false,
            },
            description: "Optional trailers.",
          },
          worktree: WORKTREE_COMMIT_PARAM,
          allowConflictMarkers: {
            type: "boolean",
            description:
              "Allow committing files with conflict markers. Default false.",
          },
        },
        required: ["paths", "subject"],
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const { worktree, ...parsed } = GitCommitArgs.parse(args);
        const tree = treeFor(worktree);
        if (tree.error) return tree.error;
        // Serialize against the other repository mutators (worktree add /
        // remove, either merge direction) on the SAME lock they take. Without
        // it a merge's dirty/ahead guards — a check-then-act re-read inside
        // that lock — could be invalidated by a commit landing mid-merge, and
        // this tool is now precisely the thing parallel sub-agents call.
        const result = await withRepositoryLock(
          await repositoryLockKey(tree.cwd),
          () => commitChanges(tree.cwd, parsed, ctx),
        );
        // Only worktree sessions get the integrate nudge; in the main checkout
        // a commit is already where the user can see it. A commit made INTO a
        // lease is nudged toward `worktree_merge` with that lease's id, since
        // that (not `git_worktree_merge`, which acts on the session's own cwd)
        // is what collects it.
        //
        // Both can apply at once: when the conversation's OWN workspace is a
        // linked worktree, collecting a lease only gets the work as far as
        // that worktree's branch, so the second leg is named too.
        const hints = [COMMIT_TICKET_FOLLOW_UP_HINT];
        if (worktree) hints.push(leaseIntegrateFollowUpHint(worktree));
        if (await isLinkedWorktree(cwd))
          hints.push(WORKTREE_INTEGRATE_FOLLOW_UP_HINT);
        return ok(result, undefined, { followUpHint: hints.join("\n\n") });
      },
    },
  ];
}
