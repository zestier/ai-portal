import { z } from 'zod';
import { showFile } from '../../git';
import { ok, type PortalTool } from '../types';
import {
	createTreeResolver,
	WorktreeSelector,
	WORKTREE_PARAM,
	type WorktreeToolContext
} from '../worktree-selector';

export const GitShowFileArgs = z
	.object({
		ref: z.string().min(1).max(200),
		path: z.string().min(1).max(4096),
		worktree: WorktreeSelector
	})
	.strict();

export function buildGitShowFileTools(cwd: string, ctx?: WorktreeToolContext): PortalTool[] {
	const treeFor = createTreeResolver(cwd, ctx);
	return [
		{
			name: 'git_show_file',
			description: 'Read one workspace file at a Git ref.',
			argsSchema: GitShowFileArgs,
			parameters: {
				type: 'object',
				properties: {
					ref: {
						type: 'string'
					},
					path: {
						type: 'string'
					},
					worktree: WORKTREE_PARAM
				},
				required: ['ref', 'path'],
				additionalProperties: false
			},
			async handler(args) {
				const { ref, path, worktree } = GitShowFileArgs.parse(args);
				const tree = treeFor(worktree);
				if (tree.error) return tree.error;
				return ok(await showFile(tree.cwd, ref, path));
			}
		}
	];
}
