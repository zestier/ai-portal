import { mkdir, rename, stat, writeFile, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { isPathInWorkspace, resolveWithParentFallback } from '../permissions/workspace';
import { err, ok, type PortalTool, type ToolPermissionRequest, type ToolResult } from './types';
import { scratchSubdir, ensureZapGitignore } from './zap-dir';
import {
	createTreeResolver,
	resolveWorktreeDir,
	WorktreeSelector,
	WORKTREE_WRITE_PARAM,
	type WorktreeToolContext
} from './worktree-selector';

const CreateDirectoryArgs = z
	.object({
		path: z.string().min(1).max(4096),
		worktree: WorktreeSelector
	})
	.strict();

const MoveArgs = z
	.object({
		source: z.string().min(1).max(4096),
		destination: z.string().min(1).max(4096),
		overwrite: z.boolean().optional(),
		worktree: WorktreeSelector
	})
	.strict();

const TrashArgs = z
	.object({
		path: z.string().min(1).max(4096),
		worktree: WorktreeSelector
	})
	.strict();

const ReadFileArgs = z
	.object({
		path: z.string().min(1).max(4096),
		worktree: WorktreeSelector,
		startLine: z.number().int().min(1).optional(),
		endLine: z.number().int().min(1).optional()
	})
	.strict();

const MAX_READ_FILE_BYTES = 5_000_000;
const MAX_READ_RESULT_BYTES = 200_000;
const DEFAULT_READ_LINE_LIMIT = 100;

// Workspace-relative directory the `trash` tool moves deleted entries into.
// Keeping it inside the workspace is deliberate: the move that performs the
// "delete" is itself an in-workspace write, so it is covered by the standard
// fs-write seed (delete ⊆ write on the same path) and stays reversible. It
// lives under the portal's `.zap/scratch` area (see ./zap-dir) so a project
// ignores one nested rule rather than a dot-dir per tool.
//
// Resolved lazily (per call, via `scratchSubdir`) rather than captured at
// import time so a `ZAP_DIR` override stays consistent with
// `ensureZapGitignore`, which also reads the env when invoked.
function trashDir(): string {
	return scratchSubdir('trash');
}

type ResolvedTarget = { ok: true; abs: string; rel: string } | { ok: false; message: string };

// Resolve a workspace-relative directory request into an absolute, symlink-
// resolved path that is provably inside the workspace. Rejects absolute inputs
// and any `..` escape that resolves outside the root (resolving the real path of
// existing ancestors first, so a symlinked parent can't be used to escape).
export function resolveWorkspaceTarget(workspaceRoot: string, rawPath: string): ResolvedTarget {
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
export function resolveAbsoluteTarget(workspaceRoot: string, rawPath: string): string | null {
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

// Classifies how `rel` relates to the trash store so the trash tool can refuse
// to bury or resurface its own state. Two distinct protections:
//   - 'inside': `rel` is the store itself or nested within it. Trashing it would
//     let an agent recursively bury, or resurface, previously deleted entries.
//   - 'ancestor': `rel` is a parent of the store (e.g. `.zap`, `.zap/scratch`).
//     Trashing it would drag the whole store along — and `rename` would anyway
//     fail trying to move a directory into its own descendant.
function trashRelation(rel: string, dir: string): 'inside' | 'ancestor' | null {
	if (rel === dir || rel.startsWith(`${dir}/`)) return 'inside';
	if (dir.startsWith(`${rel}/`)) return 'ancestor';
	return null;
}

export function buildFilesystemTools(
	workspaceRoot: string,
	ctx?: WorktreeToolContext
): PortalTool[] {
	// Resolves a `worktree` selector to the root every path in the call is
	// relative to — no selector means this conversation's own workspace. Without
	// it these tools could only ever act in the conversation's workspace, which
	// left a sub-agent working in a lease unable to mkdir, move, or delete at
	// all: paths here are workspace-relative by design, and shell
	// `mkdir`/`mv`/`rm` are not a fallback (this portal does not seed them).
	const treeFor = createTreeResolver(workspaceRoot, ctx);

	// The permission-side twin of `treeFor`. `derivePermissionRequest` must not
	// mutate anything (no `touchLease`) and cannot return an error envelope, so
	// an unresolvable selector yields null — the gateway then falls back to its
	// default custom-tool request and PROMPTS. That is the fail-closed direction:
	// deriving against `workspaceRoot` instead would describe a path the handler
	// will never touch, and could be auto-approved by the workspace fs-write seed
	// while the real write lands elsewhere.
	//
	// A resolved lease root needs no special seed: `workspaceRootsFor` already
	// includes every lease a conversation holds, so the standard fs-write seed
	// covers it exactly as it covers the primary workspace.
	function permissionRoot(leaseId: string | undefined): string | null {
		if (!leaseId) return workspaceRoot;
		return resolveWorktreeDir(leaseId, ctx);
	}

	return [
		{
			name: 'create_directory',
			description:
				"Create a directory inside the workspace. Recursive and idempotent like `mkdir -p`. Path must be workspace-relative (absolute paths and `..` escapes rejected). Pass `worktree` to act inside a held worktree instead. Prefer this over `bash mkdir` so creation routes through the auto-approved write path. On success returns `{ path, outcome }` where `outcome` is `'created'` or `'already-present'`.",
			argsSchema: CreateDirectoryArgs,
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'Workspace-relative path; parent directories created as needed.'
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
		},
		{
			name: 'move',
			description:
				'Move (rename) a file or directory within the workspace. Both `source` and `destination` must be workspace-relative (absolute paths and `..` escapes rejected). Pass `worktree` to act inside a held worktree instead. Missing destination parent directories are created. Refuses to overwrite an existing destination unless `overwrite` is true; never overwrites a directory. Prefer this over `bash mv`. Permission gated on BOTH paths: a move touching anything outside the workspace prompts.',
			argsSchema: MoveArgs,
			parameters: {
				type: 'object',
				properties: {
					source: {
						type: 'string',
						description: 'Workspace-relative path of the file/directory to move.'
					},
					destination: {
						type: 'string',
						description: 'Workspace-relative destination; parent directories created as needed.'
					},
					overwrite: {
						type: 'boolean',
						description:
							'Replace an existing destination FILE when true. Directories never overwritten. Default false.'
					},
					worktree: WORKTREE_WRITE_PARAM
				},
				required: ['source', 'destination'],
				additionalProperties: false
			},
			derivePermissionRequest(args): ToolPermissionRequest | null {
				const parsed = MoveArgs.safeParse(args);
				if (!parsed.success) return null;
				const root = permissionRoot(parsed.data.worktree);
				if (root === null) return null;
				const targets = resolveMoveTargets(root, parsed.data.source, parsed.data.destination);
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
				const { source, destination, overwrite, worktree } = MoveArgs.parse(args);
				const tree = treeFor(worktree);
				if (tree.error) return tree.error;
				const src = resolveWorkspaceTarget(tree.cwd, source);
				if (!src.ok) return err(`source: ${src.message}`);
				const dst = resolveWorkspaceTarget(tree.cwd, destination);
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
				"Safely delete a file or directory by moving it into the workspace `.zap/scratch/trash/` instead of unlinking. Reversible: each entry lands under `.zap/scratch/trash/<entryId>/` with a `meta.json` recording its original path, so it can be restored or purged later. Path must be workspace-relative (absolute paths and `..` escapes rejected); the trash store itself cannot be trashed. Pass `worktree` to delete inside a held worktree instead — the entry travels with that tree's own store. Prefer this over `bash rm`.",
			argsSchema: TrashArgs,
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'Workspace-relative path of the file/directory to delete.'
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
		},
		{
			name: 'read_file',
			description:
				'Read the content of a file in the workspace. Returns at most 100 lines unless both startLine and endLine are supplied. Path must be workspace-relative. Pass `worktree` to act inside a held worktree instead. Errors on binary files or directories.',
			argsSchema: ReadFileArgs,
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'Workspace-relative path of the file to read.'
					},
					worktree: WORKTREE_WRITE_PARAM,
					startLine: {
						type: 'number',
						description: 'Starting line number (1-indexed). Defaults to the first line.'
					},
					endLine: {
						type: 'number',
						description:
							'Ending line number (1-indexed). Supply both bounds to read more than 100 lines.'
					}
				},
				required: ['path'],
				additionalProperties: false
			},
			derivePermissionRequest(args): ToolPermissionRequest | null {
				const parsed = ReadFileArgs.safeParse(args);
				if (!parsed.success) return null;
				const root = permissionRoot(parsed.data.worktree);
				if (root === null) return null;
				const abs = resolveAbsoluteTarget(root, parsed.data.path);
				if (abs === null) return null;
				return { permissionKind: 'read', path: abs };
			},
			async handler(args) {
				const { path: rawPath, worktree, startLine, endLine } = ReadFileArgs.parse(args);
				if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
					return err('startLine must be less than or equal to endLine');
				}
				const tree = treeFor(worktree);
				if (tree.error) return tree.error;
				const resolved = resolveWorkspaceTarget(tree.cwd, rawPath);
				if (!resolved.ok) return err(resolved.message);

				try {
					const fileStat = await stat(resolved.abs);
					if (fileStat.isDirectory()) {
						return err(`Path is a directory, not a file: ${resolved.rel}`);
					}
					if (fileStat.size > MAX_READ_FILE_BYTES) {
						return err(
							`File is too large to read safely (${fileStat.size} bytes; limit is ${MAX_READ_FILE_BYTES}). Use a line range or a narrower search.`
						);
					}

					const content = await readFile(resolved.abs, { encoding: 'utf8' });

					// Binary detection: check for null bytes
					if (content.includes('\0')) {
						return err(`File contains null bytes and is likely binary: ${resolved.rel}`);
					}

					const lines = content.split(/\r?\n/);
					const hasExplicitRange = startLine !== undefined && endLine !== undefined;
					let start = Math.max(0, (startLine ?? 1) - 1);
					const end = Math.min(lines.length, endLine ?? start + DEFAULT_READ_LINE_LIMIT);
					if (!hasExplicitRange && endLine !== undefined) {
						start = Math.max(0, end - DEFAULT_READ_LINE_LIMIT);
					}
					const resultContent = lines.slice(start, end).join('\n');
					if (Buffer.byteLength(resultContent) > MAX_READ_RESULT_BYTES) {
						return err(
							`Read result is too large (${Buffer.byteLength(resultContent)} bytes; limit is ${MAX_READ_RESULT_BYTES}). Request a narrower line range.`
						);
					}

					return ok(
						{
							content: resultContent,
							size: fileStat.size,
							type: 'file',
							startLine: start + 1,
							endLine: end,
							totalLines: lines.length,
							isComplete: start === 0 && end === lines.length
						},
						`Read file: ${resolved.rel}`
					);
				} catch (e) {
					if (e instanceof Error && 'code' in e && e.code === 'ENOENT') {
						return err(`File does not exist: ${resolved.rel}`);
					}
					return err(e instanceof Error ? e.message : String(e));
				}
			}
		}
	];
}

// The `trash` handler body, parameterized on the resolved root so the lease and
// non-lease paths cannot drift: an entry trashed in a worktree lands in THAT
// tree's `.zap/scratch/trash`, keeping the deletion reversible from inside the
// tree it belongs to (and travelling with it if the tree is later inspected).
async function trashInto(root: string, rawPath: string): Promise<ToolResult> {
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
