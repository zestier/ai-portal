import { z } from 'zod';
import { showCommit } from '../../git';
import { ok, type PortalTool } from '../types';
import {
	createTreeResolver,
	WorktreeSelector,
	WORKTREE_PARAM,
	type WorktreeToolContext
} from '../worktree-selector';

export const GitShowCommitArgs = z
	.object({
		sha: z.string().min(4).max(64),
		includePatch: z.boolean().optional().default(false),
		worktree: WorktreeSelector
	})
	.strict();

export function buildGitShowCommitTools(cwd: string, ctx?: WorktreeToolContext): PortalTool[] {
	const treeFor = createTreeResolver(cwd, ctx);
	return [
		{
			name: 'git_show_commit',
			description: 'Commit details and changed files by sha.',
			argsSchema: GitShowCommitArgs,
			parameters: {
				type: 'object',
				properties: {
					sha: {
						type: 'string'
					},
					includePatch: {
						type: 'boolean',
						description: 'Include the patch. Default false.'
					},
					worktree: WORKTREE_PARAM
				},
				required: ['sha'],
				additionalProperties: false
			},
			async handler(args) {
				const { sha, includePatch, worktree } = GitShowCommitArgs.parse(args);
				const tree = treeFor(worktree);
				if (tree.error) return tree.error;
				const commit = await showCommit(tree.cwd, sha, { includePatch });
				return ok(commit);
			}
		}
	];
}
