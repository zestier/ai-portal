import { applyPatch } from 'diff';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { parseApplyPatch, type ApplyPatchChange } from '$lib/client/apply-patch';
import { isPathInWorkspace, resolveWithParentFallback } from '../permissions/workspace';
import { err, ok, type PortalTool, type ToolPermissionRequest } from './types';
import {
	createTreeResolver,
	resolveWorktreeDir,
	WorktreeSelector,
	WORKTREE_WRITE_PARAM,
	type WorktreeToolContext
} from './worktree-selector';
import { buildTrashTools } from './trash';

const ApplyPatchArgs = z
	.object({
		patch: z.string().min(1).max(1_000_000),
		worktree: WorktreeSelector,
		dryRun: z.boolean().optional().default(false)
	})
	.strict();

type Target = { abs: string; rel: string };

function target(root: string, path: string): Target | null {
	if (!path || path.includes('\0') || path.startsWith('/') || path.includes('\\')) return null;
	const resolvedRoot = resolveWithParentFallback(resolve(root));
	const abs = resolvedRoot && resolveWithParentFallback(resolve(resolvedRoot, path));
	if (!resolvedRoot || !abs || !isPathInWorkspace(abs, resolvedRoot)) return null;
	return { abs, rel: path };
}

function changesForPatch(patch: string): ApplyPatchChange[] | null {
	const changes = parseApplyPatch(patch);
	return changes && changes.length > 0 ? changes : null;
}

export function buildApplyPatchTools(
	workspaceRoot: string,
	ctx?: WorktreeToolContext
): PortalTool[] {
	const treeFor = createTreeResolver(workspaceRoot, ctx);
	function permissionRoot(worktree: string | undefined): string | null {
		return worktree ? resolveWorktreeDir(worktree, ctx) : workspaceRoot;
	}

	return [
		{
			name: 'apply_patch',
			description:
				'Apply a unified patch in the workspace. Accepts the `*** Begin Patch` format with Add File, Update File, Move to, and Delete File operations. Use dryRun to validate without changing files. Paths must stay inside the workspace; pass worktree to edit a held worktree.',
			argsSchema: ApplyPatchArgs,
			parameters: {
				type: 'object',
				properties: {
					patch: {
						type: 'string',
						description: 'Patch text enclosed by *** Begin Patch and *** End Patch.'
					},
					worktree: WORKTREE_WRITE_PARAM,
					dryRun: { type: 'boolean', description: 'Validate and report changes without writing.' }
				},
				required: ['patch'],
				additionalProperties: false
			},
			derivePermissionRequest(args): ToolPermissionRequest | null {
				const parsed = ApplyPatchArgs.safeParse(args);
				if (!parsed.success) return null;
				const root = permissionRoot(parsed.data.worktree);
				const changes = changesForPatch(parsed.data.patch);
				if (!root || !changes) return null;
				const paths = changes
					.flatMap((change) => [change.oldPath, change.newPath])
					.filter((path): path is string => path !== null);
				const absolutePaths = paths.map((path) => resolveWithParentFallback(resolve(root, path)));
				if (absolutePaths.some((path) => path === null) || absolutePaths.length === 0) return null;
				const [firstPath, ...additionalPaths] = absolutePaths;
				if (!firstPath) return null;
				return {
					permissionKind: 'write',
					path: firstPath,
					additionalPaths: additionalPaths.filter((path): path is string => path !== null)
				};
			},
			async handler(args) {
				const parsed = ApplyPatchArgs.parse(args);
				const tree = treeFor(parsed.worktree);
				if (tree.error) return tree.error;
				const changes = changesForPatch(parsed.patch);
				if (!changes)
					return err('patch is malformed or contains no changes', { code: 'invalid_patch' });
				const targets: Array<{
					change: ApplyPatchChange;
					oldTarget: Target | null;
					newTarget: Target | null;
				}> = [];
				for (const change of changes) {
					const oldTarget = change.oldPath ? target(tree.cwd, change.oldPath) : null;
					const newTarget = change.newPath ? target(tree.cwd, change.newPath) : null;
					if ((change.oldPath && !oldTarget) || (change.newPath && !newTarget)) {
						return err(`patch path escapes the workspace: ${change.path}`, {
							code: 'invalid_path'
						});
					}
					targets.push({ change, oldTarget, newTarget });
				}

				if (parsed.dryRun) {
					return ok(
						{
							dryRun: true,
							changes: targets.map(({ change }) => ({ kind: change.kind, path: change.path }))
						},
						`Validated ${targets.length} patch change(s).`
					);
				}

				const applied: string[] = [];
				for (const { change, oldTarget, newTarget } of targets) {
					try {
						if (change.kind === 'delete') {
							const trash = buildTrashTools(tree.cwd, ctx)[0];
							const result = await trash!.handler({ path: oldTarget!.rel });
							if (!result.ok) return result;
						} else if (change.kind === 'add') {
							const content = change.diff
								.split('\n')
								.slice(3)
								.filter((line) => line.startsWith('+'))
								.map((line) => line.slice(1))
								.join('\n');
							await mkdir(dirname(newTarget!.abs), { recursive: true });
							await writeFile(newTarget!.abs, content);
						} else {
							const source = await readFile(oldTarget!.abs, 'utf8');
							const result = applyPatch(source, change.diff);
							if (result === false) {
								return err(`patch did not apply cleanly: ${change.path}`, {
									code: 'patch_failed'
								});
							}
							if (oldTarget!.abs !== newTarget!.abs) {
								await mkdir(dirname(newTarget!.abs), { recursive: true });
							}
							await writeFile(newTarget!.abs, result);
							if (oldTarget!.abs !== newTarget!.abs) {
								const trash = buildTrashTools(tree.cwd, ctx)[0];
								const removed = await trash!.handler({ path: oldTarget!.rel });
								if (!removed.ok) return removed;
							}
						}
						applied.push(change.path);
					} catch (error) {
						return err(error instanceof Error ? error.message : String(error), {
							code: 'patch_failed'
						});
					}
				}
				return ok({ applied }, `Applied ${applied.length} patch change(s).`);
			}
		}
	];
}
