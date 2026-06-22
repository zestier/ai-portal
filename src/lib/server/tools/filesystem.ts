import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { isPathInWorkspace, resolveWithParentFallback } from '../permissions/workspace';
import { err, ok, type PortalTool, type ToolPermissionRequest } from './types';

const CreateDirectoryArgs = z
	.object({
		path: z.string().min(1).max(4096)
	})
	.strict();

const MoveArgs = z
	.object({
		source: z.string().min(1).max(4096),
		destination: z.string().min(1).max(4096),
		overwrite: z.boolean().optional()
	})
	.strict();

const TrashArgs = z
	.object({
		path: z.string().min(1).max(4096)
	})
	.strict();

// Workspace-relative directory the `trash` tool moves deleted entries into.
// Keeping it inside the workspace is deliberate: the move that performs the
// "delete" is itself an in-workspace write, so it is covered by the standard
// fs-write seed (delete ⊆ write on the same path) and stays reversible.
const TRASH_DIR = '.trash';

type ResolvedTarget = { ok: true; abs: string; rel: string } | { ok: false; message: string };

// Resolve a workspace-relative directory request into an absolute, symlink-
// resolved path that is provably inside the workspace. Rejects absolute inputs
// and any `..` escape that resolves outside the root (resolving the real path of
// existing ancestors first, so a symlinked parent can't be used to escape).
function resolveWorkspaceTarget(workspaceRoot: string, rawPath: string): ResolvedTarget {
	if (rawPath.includes('\0')) {
		return { ok: false, message: 'path must not contain NUL characters' };
	}
	if (isAbsolute(rawPath)) {
		return {
			ok: false,
			message: `path must be workspace-relative, not absolute: ${rawPath}`
		};
	}
	const root = resolveWithParentFallback(resolve(workspaceRoot));
	if (root === null) {
		return { ok: false, message: 'could not resolve the workspace root' };
	}
	const abs = resolveWithParentFallback(resolve(root, rawPath));
	if (abs === null) {
		return { ok: false, message: `could not resolve path: ${rawPath}` };
	}
	if (!isPathInWorkspace(abs, root)) {
		return { ok: false, message: `path escapes the workspace: ${rawPath}` };
	}
	const rel = abs === root ? '.' : relative(root, abs);
	return { ok: true, abs, rel };
}

// Best-effort absolute target for the permission request. Unlike
// `resolveWorkspaceTarget` it does NOT enforce containment: an out-of-workspace
// path is resolved and returned so the permission layer sees the real target
// and prompts (it won't match the in-workspace fs-write seed) instead of
// silently auto-approving.
function resolveAbsoluteTarget(workspaceRoot: string, rawPath: string): string | null {
	if (!rawPath || rawPath.includes('\0')) return null;
	const root = resolveWithParentFallback(resolve(workspaceRoot));
	if (root === null) return null;
	const base = isAbsolute(rawPath) ? rawPath : resolve(root, rawPath);
	return resolveWithParentFallback(base);
}

// A `move` is a two-path operation, so it must be gated on BOTH the source and
// the destination. Resolve each to an absolute, symlink-aware path (without
// enforcing containment — the handler does that) so the permission layer can
// evaluate BOTH against the user's real grants + policy and combine
// most-restrictively. Returns null when either path can't be resolved so the
// gateway falls back to its default custom-tool request.
function resolveMoveTargets(
	workspaceRoot: string,
	source: string,
	destination: string
): { source: string; destination: string } | null {
	const src = resolveAbsoluteTarget(workspaceRoot, source);
	const dst = resolveAbsoluteTarget(workspaceRoot, destination);
	if (src === null || dst === null) return null;
	return { source: src, destination: dst };
}

// True when `rel` is the trash dir itself or anything nested inside it. Used to
// stop the trash tool from trashing its own store (which would let an agent
// recursively bury, or resurface, previously deleted entries).
function isInTrash(rel: string): boolean {
	if (rel === TRASH_DIR) return true;
	const prefix = `${TRASH_DIR}/`;
	return rel.startsWith(prefix);
}

export function buildFilesystemTools(workspaceRoot: string): PortalTool[] {
	return [
		{
			name: 'create_directory',
			description:
				"Create a directory inside the workspace. Recursive and idempotent like `mkdir -p`: missing parent directories are created and an already-existing directory is a successful no-op. The path must be workspace-relative (absolute paths and `..` escapes outside the workspace are rejected). Prefer this over `bash mkdir` so directory creation routes through the structured, auto-approved write path. The `create` file tool, by contrast, requires parent directories to already exist. On success returns `{ path, outcome }` where `outcome` is `'created'` (the directory was newly made) or `'already-present'` (it already existed, so nothing was created).",
			argsSchema: CreateDirectoryArgs,
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description:
							'Workspace-relative path of the directory to create. Parent directories are created as needed.'
					}
				},
				required: ['path'],
				additionalProperties: false
			},
			derivePermissionRequest(args): ToolPermissionRequest | null {
				const parsed = CreateDirectoryArgs.safeParse(args);
				if (!parsed.success) return null;
				const abs = resolveAbsoluteTarget(workspaceRoot, parsed.data.path);
				if (abs === null) return null;
				return { permissionKind: 'write', path: abs };
			},
			async handler(args) {
				const { path: rawPath } = CreateDirectoryArgs.parse(args);
				const resolved = resolveWorkspaceTarget(workspaceRoot, rawPath);
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
		},
		{
			name: 'move',
			description:
				'Move (rename) a file or directory within the workspace. Both `source` and `destination` must be workspace-relative; absolute paths and `..` escapes outside the workspace are rejected on either side. Missing parent directories of the destination are created automatically. Refuses to overwrite an existing destination unless `overwrite` is true, and never overwrites a directory. Prefer this over `bash mv` so the move routes through the structured, auto-approved write path. Permission is gated on BOTH paths: a move that touches anything outside the workspace prompts.',
			argsSchema: MoveArgs,
			parameters: {
				type: 'object',
				properties: {
					source: {
						type: 'string',
						description: 'Workspace-relative path of the existing file or directory to move.'
					},
					destination: {
						type: 'string',
						description:
							'Workspace-relative destination path. Parent directories are created as needed.'
					},
					overwrite: {
						type: 'boolean',
						description:
							'When true, replace an existing destination FILE. Directories are never overwritten. Defaults to false.'
					}
				},
				required: ['source', 'destination'],
				additionalProperties: false
			},
			derivePermissionRequest(args): ToolPermissionRequest | null {
				const parsed = MoveArgs.safeParse(args);
				if (!parsed.success) return null;
				const targets = resolveMoveTargets(
					workspaceRoot,
					parsed.data.source,
					parsed.data.destination
				);
				if (targets === null) return null;
				// Gate on BOTH paths: the gateway evaluates source + destination
				// against the real grants and combines most-restrictively.
				return {
					permissionKind: 'write',
					path: targets.source,
					additionalPaths: [targets.destination]
				};
			},
			async handler(args) {
				const { source, destination, overwrite } = MoveArgs.parse(args);
				const src = resolveWorkspaceTarget(workspaceRoot, source);
				if (!src.ok) return err(`source: ${src.message}`);
				const dst = resolveWorkspaceTarget(workspaceRoot, destination);
				if (!dst.ok) return err(`destination: ${dst.message}`);
				if (src.abs === dst.abs) {
					return err('source and destination resolve to the same path');
				}
				try {
					const srcStat = await stat(src.abs).catch(() => null);
					if (!srcStat) return err(`source does not exist: ${src.rel}`);
					const dstStat = await stat(dst.abs).catch(() => null);
					if (dstStat) {
						if (dstStat.isDirectory()) {
							return err(`destination is an existing directory: ${dst.rel}`);
						}
						if (!overwrite) {
							return err(`destination already exists (pass overwrite to replace): ${dst.rel}`);
						}
					}
					await mkdir(dirname(dst.abs), { recursive: true });
					await rename(src.abs, dst.abs);
					return ok(
						{ source: src.rel, destination: dst.rel, overwritten: Boolean(dstStat) },
						`Moved ${src.rel} -> ${dst.rel}`
					);
				} catch (e) {
					return err(e instanceof Error ? e.message : String(e));
				}
			}
		},
		{
			name: 'trash',
			description:
				'Safely delete a file or directory by moving it into the workspace `.trash/` directory instead of unlinking it. Reversible: each entry is stored under `.trash/<entryId>/` alongside a `meta.json` recording its original path, so it can be restored or purged later. The path must be workspace-relative (absolute paths and `..` escapes are rejected), and the `.trash/` store itself cannot be trashed. Prefer this over `bash rm` — it never destroys data irrecoverably.',
			argsSchema: TrashArgs,
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'Workspace-relative path of the file or directory to delete (trash).'
					}
				},
				required: ['path'],
				additionalProperties: false
			},
			derivePermissionRequest(args): ToolPermissionRequest | null {
				const parsed = TrashArgs.safeParse(args);
				if (!parsed.success) return null;
				// Gate on the ORIGINAL path: trashing a path you may write is a
				// delete of that path, so it inherits the write grant (delete ⊆ write).
				const abs = resolveAbsoluteTarget(workspaceRoot, parsed.data.path);
				if (abs === null) return null;
				return { permissionKind: 'write', path: abs };
			},
			async handler(args) {
				const { path: rawPath } = TrashArgs.parse(args);
				const target = resolveWorkspaceTarget(workspaceRoot, rawPath);
				if (!target.ok) return err(target.message);
				if (target.rel === '.' || target.rel === '') {
					return err('refusing to trash the workspace root');
				}
				if (isInTrash(target.rel)) {
					return err('refusing to trash the .trash store itself');
				}
				try {
					const targetStat = await stat(target.abs).catch(() => null);
					if (!targetStat) return err(`path does not exist: ${target.rel}`);
					const entryId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
					const entryDirRel = `${TRASH_DIR}/${entryId}`;
					const entryDir = resolveWorkspaceTarget(workspaceRoot, entryDirRel);
					if (!entryDir.ok) return err(entryDir.message);
					const name = basename(target.rel);
					const trashedRel = `${entryDirRel}/${name}`;
					const trashedAbs = resolve(entryDir.abs, name);
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
		}
	];
}
