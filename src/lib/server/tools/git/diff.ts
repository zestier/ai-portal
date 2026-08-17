import { z } from "zod";
import { diff, diffStat, nameOnly, nameStatus, numstat } from "../../git";
import { ok, type PortalTool } from "../types";
import {
  createTreeResolver,
  WorktreeSelector,
  WORKTREE_PARAM,
  type WorktreeToolContext,
} from "../worktree-selector";
import { DiffOutput, requiresSha, TargetKind, toDiffTarget } from "./common";

export const GitDiffArgs = z
  .object({
    target: TargetKind.optional().default("worktree-vs-head"),
    sha: z.string().min(4).max(64).optional(),
    path: z.string().min(1).max(4096).optional(),
    output: DiffOutput.optional().default("patch"),
    worktree: WorktreeSelector,
  })
  .strict()
  .refine((args) => !requiresSha(args.target) || args.sha !== undefined, {
    path: ["sha"],
    message: "sha is required when target is commit or commit-vs-parent",
  })
  .prefault({});

export function buildGitDiffTools(
  cwd: string,
  ctx?: WorktreeToolContext,
): PortalTool[] {
  const treeFor = createTreeResolver(cwd, ctx);
  return [
    {
      name: "git_diff",
      description: "Git diff between worktree/index/commit.",
      argsSchema: GitDiffArgs,
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: TargetKind.options,
            description:
              "Default worktree-vs-head; commit targets require sha.",
          },
          sha: {
            type: "string",
          },
          path: {
            type: "string",
          },
          output: {
            type: "string",
            enum: DiffOutput.options,
            description:
              "patch (default) | stat | numstat | name-only | name-status.",
          },
          worktree: WORKTREE_PARAM,
        },
        additionalProperties: false,
      },
      async handler(args) {
        const parsed = GitDiffArgs.parse(args);
        const tree = treeFor(parsed.worktree);
        if (tree.error) return tree.error;
        const target = toDiffTarget(parsed.target, parsed.sha);
        switch (parsed.output) {
          case "patch": {
            const out = await diff(tree.cwd, target, parsed.path);
            return ok(out || "(no diff)");
          }
          case "stat":
            return ok(await diffStat(tree.cwd, target, parsed.path));
          case "numstat":
            return ok({ files: await numstat(tree.cwd, target, parsed.path) });
          case "name-only":
            return ok({ files: await nameOnly(tree.cwd, target, parsed.path) });
          case "name-status":
            return ok({
              files: await nameStatus(tree.cwd, target, parsed.path),
            });
        }
      },
    },
  ];
}
