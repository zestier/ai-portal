import type { PortalTool } from './types';
import { buildFilesystemTools } from './filesystem';
import type { WorktreeToolContext } from './worktree-selector';

export function buildMoveTools(workspaceRoot: string, ctx?: WorktreeToolContext): PortalTool[] {
	return buildFilesystemTools(workspaceRoot, ctx).filter((tool) => tool.name === 'move');
}
