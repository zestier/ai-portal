import { z } from "zod";
import { log } from "../../git";
import { ok, type PortalTool } from "../types";
import {
  createTreeResolver,
  WorktreeSelector,
  WORKTREE_PARAM,
  type WorktreeToolContext,
} from "../worktree-selector";

export const GitLogArgs = z
  .object({
    limit: z.number().int().min(1).max(50).optional().default(20),
    skip: z.number().int().min(0).max(1000).optional().default(0),
    ref: z.string().min(1).max(200).optional(),
    path: z.string().min(1).max(4096).optional(),
    worktree: WorktreeSelector,
  })
  .strict()
  .prefault({});

export function buildGitLogTools(
  cwd: string,
  ctx?: WorktreeToolContext,
): PortalTool[] {
  const treeFor = createTreeResolver(cwd, ctx);
  return [
    {
      name: "git_log",
      description: "Recent commits with author, timestamp, subject.",
      argsSchema: GitLogArgs,
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "1-50 (default 20).",
          },
          skip: {
            type: "number",
          },
          ref: {
            type: "string",
          },
          path: {
            type: "string",
          },
          worktree: WORKTREE_PARAM,
        },
        additionalProperties: false,
      },
      async handler(args) {
        const { worktree, ...parsed } = GitLogArgs.parse(args);
        const tree = treeFor(worktree);
        if (tree.error) return tree.error;
        const entries = await log(tree.cwd, parsed);
        return ok({ commits: entries });
      },
    },
  ];
}
