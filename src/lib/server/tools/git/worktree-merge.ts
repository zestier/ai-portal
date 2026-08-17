import { z } from "zod";
import {
  mergeWorktree,
  WorktreeIntegrationError,
} from "../../worktree-integration";
import { err, ok, type PortalTool } from "../types";
import { SquashArg, SQUASH_PARAM } from "../commit-message-args";
import { mergeInProgressFollowUpHint } from "../follow-up-hints";
import { toolErrorFor } from "./common";

export const GitWorktreeMergeArgs = z
  .object({
    direction: z.enum(["from-source", "to-source"]),
    allowMergeCommit: z.boolean().optional().default(false),
    onConflict: z.enum(["abort", "keep"]).optional().default("abort"),
    squash: SquashArg,
  })
  .strict();

export function buildGitWorktreeMergeTools(cwd: string): PortalTool[] {
  return [
    {
      name: "git_worktree_merge",
      description:
        "Merge this linked GIT worktree’s branch with the main checkout’s branch.",
      promptGuidelines: [
        "Prefer `squash` for one commit per unit of work. Refuses with uncommitted changes on either side; never leaves the main checkout mid-merge.",
      ],
      argsSchema: GitWorktreeMergeArgs,
      permissionBehavior: "always-prompt",
      parameters: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["from-source", "to-source"],
            description: "to-source | from-source.",
          },
          allowMergeCommit: {
            type: "boolean",
            description: "to-source only. Default false (fast-forward).",
          },
          squash: SQUASH_PARAM,
          onConflict: {
            type: "string",
            enum: ["abort", "keep"],
            description:
              "from-source only. abort (default) rolls back; keep leaves the conflict to finish with git_commit or discard with git_merge_abort. to-source always rolls back.",
          },
        },
        required: ["direction"],
        additionalProperties: false,
      },
      async handler(args) {
        const { squash, ...parsed } = GitWorktreeMergeArgs.parse(args);
        try {
          const result = await mergeWorktree(cwd, {
            ...parsed,
            ...(squash === undefined ? {} : { squash }),
          });
          return ok(
            result,
            result.merged
              ? `Merged ${result.from} into ${result.into}${result.fastForward ? " (fast-forward)" : ""}${
                  result.squashedCommits === undefined
                    ? ""
                    : `, squashed from ${result.squashedCommits} commit(s)`
                }`
              : `Already up to date: nothing to merge into ${result.into}`,
          );
        } catch (cause) {
          // A kept conflict is the one failure that leaves state behind, and
          // it is a dead end unless the agent is told how to leave it.
          if (
            cause instanceof WorktreeIntegrationError &&
            cause.code === "merge_conflict" &&
            parsed.direction === "from-source" &&
            parsed.onConflict === "keep"
          ) {
            return err(`${cause.message}. ${mergeInProgressFollowUpHint()}`, {
              code: cause.code,
              details: cause.detail,
            });
          }
          return toolErrorFor(cause);
        }
      },
    },
  ];
}
