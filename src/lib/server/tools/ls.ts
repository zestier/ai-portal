import { createLsTool } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { err, ok, type PortalTool, type ToolPermissionRequest } from './types';
import { resolveWorkspaceTarget } from './filesystem';
import {
	createTreeResolver,
	resolveWorktreeDir,
	WorktreeSelector,
	WORKTREE_PARAM,
	type WorktreeToolContext
} from './worktree-selector';

// pi's `ls` schema (`{ path?, limit? }`) extended with the portal `worktree`
// selector. `path` stays workspace-relative per the portal contract; the
// handler resolves it against the selected root before handing an ABSOLUTE path
// to pi, whose `ls` executes against the local filesystem.
const LsArgs = z
	.object({
		path: z.string().min(1).max(4096).optional(),
		// pi's default entry cap is 500; the model may raise it explicitly.
		limit: z.number().int().min(1).max(10_000).optional(),
		worktree: WorktreeSelector
	})
	.strict();

// The model-facing text pi renders for the listing (its `content` blocks).
function lsViewText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter(
			(block): block is { type: 'text'; text: string } =>
				block.type === 'text' && typeof block.text === 'string'
		)
		.map((block) => block.text)
		.join('\n');
}

export function buildLsTools(workspaceRoot: string, ctx?: WorktreeToolContext): PortalTool[] {
	const treeFor = createTreeResolver(workspaceRoot, ctx);
	const permissionRoot = (worktree: string | undefined) =>
		worktree ? resolveWorktreeDir(worktree, ctx) : workspaceRoot;
	// pi's ls binds to a cwd for relative-path resolution, but the portal always
	// passes an absolute, containment-checked path, so one instance serves every
	// root. Its `exists`/`stat`/`readdir` ops run against the real filesystem.
	const lsTool = createLsTool(workspaceRoot);

	return [
		{
			name: 'ls',
			description:
				'List a single workspace directory (sorted, `/` suffix for dirs, includes dotfiles).',
			argsSchema: LsArgs,
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'Directory (default: root).'
					},
					limit: {
						type: 'number',
						description: 'Max entries.'
					},
					worktree: WORKTREE_PARAM
				},
				additionalProperties: false
			},
			derivePermissionRequest(args): ToolPermissionRequest | null {
				const parsed = LsArgs.safeParse(args);
				if (!parsed.success) return null;
				const root = permissionRoot(parsed.data.worktree);
				if (root === null) return null;
				const target = parsed.data.path
					? resolveWorkspaceTarget(root, parsed.data.path)
					: { ok: true as const, abs: root, rel: '.' };
				if (!target.ok) return null;
				return { permissionKind: 'read', path: target.abs };
			},
			async handler(args, toolCtx) {
				const parsed = LsArgs.parse(args);
				const tree = treeFor(parsed.worktree);
				if (tree.error) return tree.error;
				const target = parsed.path
					? resolveWorkspaceTarget(tree.cwd, parsed.path)
					: { ok: true as const, abs: tree.cwd, rel: '.' };
				if (!target.ok) return err(target.message, { code: 'invalid_path' });
				try {
					const result = await lsTool.execute(
						'ls',
						{
							path: target.abs,
							...(parsed.limit !== undefined ? { limit: parsed.limit } : {})
						},
						toolCtx?.signal
					);
					const text = lsViewText(result.content);
					return ok(
						{
							path: target.rel,
							...(result.details !== undefined ? { details: result.details } : {}),
							text
						},
						`Listed ${target.rel === '.' ? 'workspace root' : target.rel}`,
						{ views: [{ type: 'text', text }] }
					);
				} catch (error) {
					return err(error instanceof Error ? error.message : String(error), {
						code: 'ls_failed'
					});
				}
			}
		}
	];
}
