import { z } from 'zod';
import { listWorktrees } from '../../worktree-integration';
import { ok, type PortalTool } from '../types';
import {
	createTreeResolver,
	WorktreeSelector,
	WORKTREE_PARAM,
	type WorktreeToolContext
} from '../worktree-selector';
import { toolErrorFor } from './common';

export const GitWorktreeListArgs = z
	.object({
		includeDirty: z.boolean().optional().default(false),
		worktree: WorktreeSelector
	})
	.strict()
	.prefault({});

export function buildGitWorktreeListTools(cwd: string, ctx?: WorktreeToolContext): PortalTool[] {
	const treeFor = createTreeResolver(cwd, ctx);
	return [
		{
			name: 'git_worktree_list',
			description:
				'List every GIT worktree (main + linked) with branch, commit, and detached/locked/prunable state. Read-only.',
			promptGuidelines: [
				'Sees all worktrees, including ones created outside the portal — unlike `worktree_list`, which only sees portal worktree leases this conversation holds.'
			],
			argsSchema: GitWorktreeListArgs,
			parameters: {
				type: 'object',
				properties: {
					includeDirty: {
						type: 'boolean',
						description: 'Also count uncommitted changes.'
					},
					worktree: WORKTREE_PARAM
				},
				additionalProperties: false
			},
			async handler(args) {
				const parsed = GitWorktreeListArgs.parse(args);
				const tree = treeFor(parsed.worktree);
				if (tree.error) return tree.error;
				try {
					return ok(await listWorktrees(tree.cwd, { includeDirty: parsed.includeDirty }));
				} catch (cause) {
					return toolErrorFor(cause);
				}
			}
		}
	];
}
