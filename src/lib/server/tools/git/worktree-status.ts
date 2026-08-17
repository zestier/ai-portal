import { z } from 'zod';
import { worktreeIntegrationStatus } from '../../worktree-integration';
import { ok, type PortalTool } from '../types';
import {
	createTreeResolver,
	WorktreeSelector,
	WORKTREE_PARAM,
	type WorktreeToolContext
} from '../worktree-selector';
import { toolErrorFor } from './common';

export const GitWorktreeStatusArgs = z
	.object({
		worktree: WorktreeSelector
	})
	.strict()
	.prefault({});

export function buildGitWorktreeStatusTools(cwd: string, ctx?: WorktreeToolContext): PortalTool[] {
	const treeFor = createTreeResolver(cwd, ctx);
	return [
		{
			name: 'git_worktree_status',
			description:
				'Report GIT worktree state for the selected tree: linked?, branch, ahead/behind, and unmerged work. Read-only.',
			argsSchema: GitWorktreeStatusArgs,
			parameters: {
				type: 'object',
				properties: { worktree: WORKTREE_PARAM },
				additionalProperties: false
			},
			async handler(args) {
				const { worktree } = GitWorktreeStatusArgs.parse(args);
				const tree = treeFor(worktree);
				if (tree.error) return tree.error;
				try {
					return ok(await worktreeIntegrationStatus(tree.cwd));
				} catch (cause) {
					return toolErrorFor(cause);
				}
			}
		}
	];
}
