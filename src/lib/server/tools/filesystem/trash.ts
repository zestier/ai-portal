import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { z } from 'zod';
import {
	WORKTREE_WRITE_PARAM,
	WorktreeSelector,
	type WorktreeToolContext
} from '../worktree-selector';
import { err, ok, type PortalTool, type ToolPermissionRequest, type ToolResult } from '../types';
import { ensureZapGitignore } from '../zap-dir';
import {
	buildFilesystemCtx,
	resolveAbsoluteTarget,
	resolveWorkspaceTarget,
	trashDir,
	trashRelation
} from './targets';

export const TrashArgs = z
	.object({
		path: z.string().min(1).max(4096),
		worktree: WorktreeSelector
	})
	.strict();

export function buildTrashTools(workspaceRoot: string, ctx?: WorktreeToolContext): PortalTool[] {
	const { treeFor, permissionRoot } = buildFilesystemCtx(workspaceRoot, ctx);
	return [
		{
			name: 'trash',
			description:
				'Safely delete a file or directory by moving it into the workspace trash (`.zap/scratch/trash/`), reversible.',
			promptGuidelines: ['Refuses to trash the trash store itself or a parent that contains it.'],
			argsSchema: TrashArgs,
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'Workspace-relative path to delete.'
					},
					worktree: WORKTREE_WRITE_PARAM
				},
				required: ['path'],
				additionalProperties: false
			},
			derivePermissionRequest(args): ToolPermissionRequest | null {
				const parsed = TrashArgs.safeParse(args);
				if (!parsed.success) return null;
				// Gate on the ORIGINAL path: trashing a path you may write is a
				// delete of that path, so it inherits the write grant (delete ⊆ write).
				const root = permissionRoot(parsed.data.worktree);
				if (root === null) return null;
				const abs = resolveAbsoluteTarget(root, parsed.data.path);
				if (abs === null) return null;
				return { permissionKind: 'write', path: abs };
			},
			async handler(args) {
				const { path: rawPath, worktree } = TrashArgs.parse(args);
				const tree = treeFor(worktree);
				if (tree.error) return tree.error;
				return trashInto(tree.cwd, rawPath);
			}
		}
	];
}

// The `trash` handler body, parameterized on the resolved root so the lease and
// non-lease paths cannot drift: an entry trashed in a worktree lands in THAT
// tree's `.zap/scratch/trash`, keeping the deletion reversible from inside the
// tree it belongs to (and travelling with it if the tree is later inspected).
export async function trashInto(root: string, rawPath: string): Promise<ToolResult> {
	const target = resolveWorkspaceTarget(root, rawPath);
	if (!target.ok) return err(target.message);
	if (target.rel === '.' || target.rel === '') {
		return err('refusing to trash the workspace root');
	}
	const dir = trashDir();
	// Compare `target.rel` against the REALPATH-resolved trash dir, not
	// the lexical `.zap/scratch/trash` string. `target.rel` is already
	// symlink-resolved (resolveWorkspaceTarget realpaths existing
	// ancestors), so if `.zap` is itself a symlink a lexical compare
	// would miss — letting the tool re-bury an already-trashed entry and
	// stamp meta.json with the wrong originalPath. Resolving the store
	// the same way keeps both sides in the same (real) namespace.
	const resolvedDir = resolveWorkspaceTarget(root, dir);
	const dirForCompare = resolvedDir.ok ? resolvedDir.rel : dir;
	const relation = trashRelation(target.rel, dirForCompare);
	if (relation === 'inside') {
		return err('refusing to trash the trash store itself');
	}
	if (relation === 'ancestor') {
		return err(`refusing to trash ${target.rel}: it contains the trash store`);
	}
	try {
		const targetStat = await stat(target.abs).catch(() => null);
		if (!targetStat) return err(`path does not exist: ${target.rel}`);
		const entryId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
		const entryDirRel = `${dir}/${entryId}`;
		const entryDir = resolveWorkspaceTarget(root, entryDirRel);
		if (!entryDir.ok) return err(entryDir.message);
		const name = basename(target.rel);
		const trashedRel = `${entryDirRel}/${name}`;
		const trashedAbs = resolve(entryDir.abs, name);
		// Drop a self-contained .zap/.gitignore so the scratch tree
		// (this trash store included) stays out of the host repo
		// without us touching its root .gitignore.
		await ensureZapGitignore(root);
		await mkdir(entryDir.abs, { recursive: true });
		await writeFile(
			resolve(entryDir.abs, 'meta.json'),
			JSON.stringify(
				{
					originalPath: target.rel,
					name,
					type: targetStat.isDirectory() ? 'directory' : 'file',
					trashedAt: new Date().toISOString()
				},
				null,
				2
			)
		);
		await rename(target.abs, trashedAbs);
		return ok(
			{ originalPath: target.rel, entryId, trashPath: trashedRel },
			`Trashed ${target.rel}`
		);
	} catch (e) {
		return err(e instanceof Error ? e.message : String(e));
	}
}
