import { z } from "zod";
import { abortMerge, mergeState, repositoryLockKey } from "../../git";
import { withRepositoryLock } from "../../repo-lock";
import { err, ok, type PortalTool } from "../types";
import {
  createTreeResolver,
  WorktreeSelector,
  WORKTREE_PARAM,
  type WorktreeToolContext,
} from "../worktree-selector";

export const GitMergeAbortArgs = z
  .object({
    worktree: WorktreeSelector,
  })
  .strict()
  .prefault({});

export function buildGitMergeAbortTools(
  cwd: string,
  ctx?: WorktreeToolContext,
): PortalTool[] {
  const treeFor = createTreeResolver(cwd, ctx);
  return [
    {
      name: "git_merge_abort",
      description:
        "Abort an in-progress merge, discarding the merge and any resolution work.",
      argsSchema: GitMergeAbortArgs,
      // Destructive: it throws away whatever resolution the tree holds, so it
      // is confirmed for the same reason `git_commit` is.
      permissionBehavior: "always-prompt",
      parameters: {
        type: "object",
        properties: { worktree: WORKTREE_PARAM },
        additionalProperties: false,
      },
      async handler(args) {
        const parsed = GitMergeAbortArgs.parse(args);
        const tree = treeFor(parsed.worktree);
        if (tree.error) return tree.error;
        // Same lock as `git_commit` and the worktree merges: aborting rewrites
        // the index and working tree of a repository another session may be
        // mid-operation on.
        const cwdForAbort = tree.cwd;
        const outcome = await withRepositoryLock(
          await repositoryLockKey(cwdForAbort),
          async () =>
            (await mergeState(cwdForAbort)).inProgress
              ? {
                  aborted: true as const,
                  result: await abortMerge(cwdForAbort),
                }
              : { aborted: false as const },
        );
        if (!outcome.aborted) {
          return err("no merge is in progress in this tree", {
            code: "no_merge_in_progress",
          });
        }
        return ok(
          outcome.result,
          `Aborted the in-progress merge; tree is back at ${outcome.result.headSha}`,
        );
      },
    },
  ];
}
