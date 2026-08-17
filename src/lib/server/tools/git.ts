import type { PortalTool } from "./types";
import type { GitToolContext } from "./git/common";
import { buildGitStatusTools } from "./git/status";
import { buildGitDiffTools } from "./git/diff";
import { buildGitLogTools } from "./git/log";
import { buildGitShowCommitTools } from "./git/show-commit";
import { buildGitShowFileTools } from "./git/show-file";
import { buildGitCommitTools } from "./git/commit";
import { buildGitMergeAbortTools } from "./git/merge-abort";
import { buildGitWorktreeStatusTools } from "./git/worktree-status";
import { buildGitWorktreeListTools } from "./git/worktree-list";
import { buildGitWorktreeMergeTools } from "./git/worktree-merge";

export { buildGitStatusTools } from "./git/status";
export { buildGitDiffTools } from "./git/diff";
export { buildGitLogTools } from "./git/log";
export { buildGitShowCommitTools } from "./git/show-commit";
export { buildGitShowFileTools } from "./git/show-file";
export { buildGitCommitTools } from "./git/commit";
export { buildGitMergeAbortTools } from "./git/merge-abort";
export { buildGitWorktreeStatusTools } from "./git/worktree-status";
export { buildGitWorktreeListTools } from "./git/worktree-list";
export { buildGitWorktreeMergeTools } from "./git/worktree-merge";
export * from "./git/common";

// Re-exported so existing importers of these symbols from `./git` keep
// compiling now that the canonical definitions live in `./types`.
export { ok, err } from "./types";
export type {
  PortalTool,
  ToolStreamContext,
  ToolResult,
  ToolError,
} from "./types";

export function buildGitTools(cwd: string, ctx?: GitToolContext): PortalTool[] {
  return [
    ...buildGitStatusTools(cwd, ctx),
    ...buildGitDiffTools(cwd, ctx),
    ...buildGitLogTools(cwd, ctx),
    ...buildGitShowCommitTools(cwd, ctx),
    ...buildGitShowFileTools(cwd, ctx),
    ...buildGitCommitTools(cwd, ctx),
    ...buildGitMergeAbortTools(cwd, ctx),
    ...buildGitWorktreeStatusTools(cwd, ctx),
    ...buildGitWorktreeListTools(cwd, ctx),
    ...buildGitWorktreeMergeTools(cwd),
  ];
}
