import { createFindTool } from '@earendil-works/pi-coding-agent';
import { access } from 'node:fs/promises';
import { relative } from 'node:path';
import { ripgrep } from 'ripgrep';
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

// pi's `find` schema (`{ pattern, path?, limit? }`) extended with the portal
// `worktree` selector. `path` stays workspace-relative per the portal contract;
// the handler resolves it against the selected root before handing an ABSOLUTE
// path to pi.
const FindArgs = z
	.object({
		pattern: z.string().min(1).max(4096),
		path: z.string().min(1).max(4096).optional(),
		// pi's default result cap is 1000; the model may raise it explicitly.
		limit: z.number().int().min(1).max(10_000).optional(),
		worktree: WorktreeSelector
	})
	.strict();

// pi's find shells out to `fd` when no custom glob operation is supplied. The
// portal supplies a ripgrep-based glob instead, so the find tool works without
// `fd` (no download side effects) and stays inside the sandbox's preopens.
// rg respects .gitignore by default — matching pi's documented find semantics —
// and pi's `ignore` list keeps node_modules/.git out even when not gitignored.
async function globFiles(
	pattern: string,
	searchPath: string,
	opts: { ignore: string[]; limit: number }
): Promise<string[]> {
	// `--no-require-git`: honor .gitignore even when the search root is not
	// inside a git repository (rg otherwise only consults it inside one).
	const rgArgs = ['--files', '--no-require-git', '--glob', pattern];
	for (const ignore of opts.ignore) rgArgs.push('--glob', `!${ignore}`);
	rgArgs.push(searchPath);
	const { code, stdout, stderr } = await ripgrep(rgArgs, {
		buffer: true,
		nodeWasi: false,
		preopens: { '.': searchPath }
	});
	if (code !== 0 && code !== 1) {
		throw new Error(stderr || stdout || 'find failed');
	}
	const paths = stdout
		.split(/\r?\n/)
		.filter(Boolean)
		.map((p) => relative(searchPath, p).replaceAll('\\', '/'))
		.sort();
	return paths.slice(0, opts.limit);
}

async function pathExists(abs: string): Promise<boolean> {
	try {
		await access(abs);
		return true;
	} catch {
		return false;
	}
}

// The model-facing text pi renders for the search (its `content` blocks).
function findViewText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter(
			(block): block is { type: 'text'; text: string } =>
				block.type === 'text' && typeof block.text === 'string'
		)
		.map((block) => block.text)
		.join('\n');
}

export function buildFindTools(workspaceRoot: string, ctx?: WorktreeToolContext): PortalTool[] {
	const treeFor = createTreeResolver(workspaceRoot, ctx);
	const permissionRoot = (worktree: string | undefined) =>
		worktree ? resolveWorktreeDir(worktree, ctx) : workspaceRoot;
	// pi's find binds to a cwd for relative-path resolution, but the portal
	// always passes an absolute, containment-checked path, so one instance
	// serves every root.
	const findTool = createFindTool(workspaceRoot, {
		operations: {
			exists: pathExists,
			glob: globFiles
		}
	});

	return [
		{
			name: 'find',
			description: 'Find workspace files by glob pattern (e.g. `*.ts`).',
			promptGuidelines: [
				'Respects .gitignore and excludes node_modules. Use `grep` for file contents.'
			],
			argsSchema: FindArgs,
			parameters: {
				type: 'object',
				properties: {
					pattern: {
						type: 'string',
						description: 'Glob pattern, e.g. `*.ts`.'
					},
					path: {
						type: 'string',
						description: 'Directory to search (default: root).'
					},
					limit: {
						type: 'number',
						description: 'Max results.'
					},
					worktree: WORKTREE_PARAM
				},
				required: ['pattern'],
				additionalProperties: false
			},
			derivePermissionRequest(args): ToolPermissionRequest | null {
				const parsed = FindArgs.safeParse(args);
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
				const parsed = FindArgs.parse(args);
				const tree = treeFor(parsed.worktree);
				if (tree.error) return tree.error;
				const target = parsed.path
					? resolveWorkspaceTarget(tree.cwd, parsed.path)
					: { ok: true as const, abs: tree.cwd, rel: '.' };
				if (!target.ok) return err(target.message, { code: 'invalid_path' });
				try {
					const result = await findTool.execute(
						'find',
						{
							pattern: parsed.pattern,
							path: target.abs,
							...(parsed.limit !== undefined ? { limit: parsed.limit } : {})
						},
						toolCtx?.signal
					);
					const text = findViewText(result.content);
					return ok(
						{
							pattern: parsed.pattern,
							path: target.rel,
							...(result.details !== undefined ? { details: result.details } : {}),
							text
						},
						`Found files matching ${parsed.pattern}`,
						{ views: [{ type: 'text', text }] }
					);
				} catch (error) {
					return err(error instanceof Error ? error.message : String(error), {
						code: 'find_failed'
					});
				}
			}
		}
	];
}
