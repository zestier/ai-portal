import { z } from "zod";
import {
  aggregateStatus,
  headInfo,
  isGitRepo,
  mergeState,
  status,
} from "../../git";
import { ok, type PortalTool } from "../types";
import {
  createTreeResolver,
  WorktreeSelector,
  WORKTREE_PARAM,
  type WorktreeToolContext,
} from "../worktree-selector";
import { mergeStatusFollowUpHint } from "./common";

export const GitStatusArgs = z
  .object({
    includeIgnored: z.boolean().optional().default(false),
    worktree: WorktreeSelector,
  })
  .strict()
  .prefault({});

export function buildGitStatusTools(
  cwd: string,
  ctx?: WorktreeToolContext,
): PortalTool[] {
  const treeFor = createTreeResolver(cwd, ctx);
  return [
    {
      name: "git_status",
      description: "Git status: head, changes, and any in-progress merge.",
      promptGuidelines: [
        "Use git_status/git_diff/git_log/git_show_commit/git_show_file/git_commit instead of shell git.",
      ],
      argsSchema: GitStatusArgs,
      parameters: {
        type: "object",
        properties: {
          includeIgnored: {
            type: "boolean",
            description: "Include ignored files.",
          },
          worktree: WORKTREE_PARAM,
        },
        additionalProperties: false,
      },
      async handler(args) {
        const parsed = GitStatusArgs.parse(args);
        const tree = treeFor(parsed.worktree);
        if (tree.error) return tree.error;
        const includeIgnored = parsed.includeIgnored;
        if (!(await isGitRepo(tree.cwd))) {
          return ok({ initialized: false, changes: [] });
        }
        const [head, entries, merge] = await Promise.all([
          headInfo(tree.cwd),
          status(tree.cwd, { includeIgnored }),
          mergeState(tree.cwd),
        ]);
        return ok(
          {
            initialized: true,
            head,
            merge,
            changes: entries.map((e) => ({
              ...e,
              status: aggregateStatus(e, { includeIgnored }),
            })),
          },
          undefined,
          mergeStatusFollowUpHint(merge, parsed.worktree),
        );
      },
    },
  ];
}
