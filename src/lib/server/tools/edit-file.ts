import type { PortalTool } from './types';
import type { WorktreeToolContext } from './worktree-selector';
import { buildEditTool } from './edit-file/edit';
import { buildWriteTool } from './edit-file/write';

export { buildEditTool } from './edit-file/edit';
export { buildWriteTool } from './edit-file/write';
export * from './edit-file/common';

export function buildEditFileTools(workspaceRoot: string, ctx?: WorktreeToolContext): PortalTool[] {
	return [buildEditTool(workspaceRoot, ctx), buildWriteTool(workspaceRoot, ctx)];
}
