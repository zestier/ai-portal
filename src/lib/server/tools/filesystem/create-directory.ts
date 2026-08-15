import { mkdir, stat } from 'node:fs/promises';
import { z } from 'zod';
import {
	WORKTREE_WRITE_PARAM,
	WorktreeSelector,
	type WorktreeToolContext
} from '../worktree-selector';
import { err, ok, type PortalTool, type ToolPermissionRequest } from '../types';
import { buildFilesystemCtx, resolveAbsoluteTarget, resolveWorkspaceTarget } from './targets';

export const CreateDirectoryArgs = z
	.object({
		path: z.string().min(1).max(4096),
		worktree: WorktreeSelector
	})
	.strict();

export function buildCreateDirectoryTools(
	workspaceRoot: string,
	ctx?: WorktreeToolContext
): PortalTool[] {
	const { treeFor, permissionRoot } = buildFilesystemCtx(workspaceRoot, ctx);
	return [
		{
			name: 'create_directory',
			description: 'Create a directory recursively (idempotent like `mkdir -p`).',
			promptGuidelines: [
				'Paths must be workspace-relative; absolute paths and `..` escapes are rejected.'
			],
			argsSchema: CreateDirectoryArgs,
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'Workspace-relative path.'
					},
					worktree: WORKTREE_WRITE_PARAM
				},
				required: ['path'],
				additionalProperties: false
			},
			derivePermissionRequest(args): ToolPermissionRequest | null {
				const parsed = CreateDirectoryArgs.safeParse(args);
				if (!parsed.success) return null;
				const root = permissionRoot(parsed.data.worktree);
				if (root === null) return null;
				const abs = resolveAbsoluteTarget(root, parsed.data.path);
				if (abs === null) return null;
				return { permissionKind: 'write', path: abs };
			},
			async handler(args) {
				const { path: rawPath, worktree } = CreateDirectoryArgs.parse(args);
				const tree = treeFor(worktree);
				if (tree.error) return tree.error;
				const resolved = resolveWorkspaceTarget(tree.cwd, rawPath);
				if (!resolved.ok) return err(resolved.message);
				try {
					const existing = await stat(resolved.abs).catch(() => null);
					if (existing) {
						if (!existing.isDirectory()) {
							return err(`path exists and is not a directory: ${resolved.rel}`);
						}
						return ok(
							{ path: resolved.rel, outcome: 'already-present' },
							`Directory already present: ${resolved.rel}`
						);
					}
					await mkdir(resolved.abs, { recursive: true });
					return ok(
						{ path: resolved.rel, outcome: 'created' },
						`Created directory: ${resolved.rel}`
					);
				} catch (e) {
					return err(e instanceof Error ? e.message : String(e));
				}
			}
		}
	];
}
