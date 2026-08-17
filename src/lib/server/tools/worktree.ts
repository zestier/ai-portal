import type { PortalTool } from "./types";
import { buildWorktreeCreateTool } from "./worktree/create";
import { buildWorktreeListTool } from "./worktree/list";
import { buildWorktreeStatusTool } from "./worktree/status";
import { buildWorktreeMergeTool } from "./worktree/merge";
import { buildWorktreeRemoveTool } from "./worktree/remove";

export { buildWorktreeCreateTool } from "./worktree/create";
export { buildWorktreeListTool } from "./worktree/list";
export { buildWorktreeStatusTool } from "./worktree/status";
export { buildWorktreeMergeTool } from "./worktree/merge";
export { buildWorktreeRemoveTool } from "./worktree/remove";
export * from "./worktree/common";

export function buildWorktreeTools(ctx: {
  userId: number;
  conversationId: number;
}): PortalTool[] {
  return [
    buildWorktreeCreateTool(ctx),
    buildWorktreeListTool(ctx),
    buildWorktreeStatusTool(ctx),
    buildWorktreeMergeTool(ctx),
    buildWorktreeRemoveTool(ctx),
  ];
}
