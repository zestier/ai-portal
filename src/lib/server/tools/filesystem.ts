import { mkdir, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { isPathInWorkspace, resolveWithParentFallback } from '../permissions/workspace';
import { err, ok, type PortalTool, type ToolPermissionRequest } from './types';

const CreateDirectoryArgs = z
	.object({
		path: z.string().min(1).max(4096)
	})
	.strict();

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

export function buildFilesystemTools(workspaceRoot: string): PortalTool[] {
	return [
		{
			name: 'create_directory',
			description:
				'Create a directory inside the workspace. Recursive and idempotent like `mkdir -p`: missing parent directories are created and an already-existing directory is a successful no-op. The path must be workspace-relative (absolute paths and `..` escapes outside the workspace are rejected). Prefer this over `bash mkdir` so directory creation routes through the structured, auto-approved write path. The `create` file tool, by contrast, requires parent directories to already exist.',
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
						return ok({ path: resolved.rel, created: false });
					}
					await mkdir(resolved.abs, { recursive: true });
					return ok({ path: resolved.rel, created: true });
				} catch (e) {
					return err(e instanceof Error ? e.message : String(e));
				}
			}
		}
	];
}
