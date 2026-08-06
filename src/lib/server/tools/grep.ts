import { resolve } from 'node:path';
import { ripgrep } from 'ripgrep';
import { z } from 'zod';
import { isPathInWorkspace, resolveWithParentFallback } from '../permissions/workspace';
import { err, ok, type PortalTool, type ToolPermissionRequest } from './types';
import {
	createTreeResolver,
	resolveWorktreeDir,
	WorktreeSelector,
	WORKTREE_PARAM,
	type WorktreeToolContext
} from './worktree-selector';

const MAX_GREP_OUTPUT_BYTES = 100_000;
const GrepArgs = z
	.object({
		pattern: z.string().min(1).max(4096),
		path: z.string().min(1).max(4096).optional(),
		glob: z.string().max(512).optional(),
		contextLines: z.number().int().min(0).max(20).optional().default(0),
		maxMatches: z.number().int().min(1).max(500).optional().default(100),
		caseSensitive: z.boolean().optional().default(true),
		worktree: WorktreeSelector
	})
	.strict();

function resolveTarget(root: string, rawPath: string | undefined): string | null {
	const resolvedRoot = resolveWithParentFallback(resolve(root));
	const target = resolveWithParentFallback(resolve(resolvedRoot ?? root, rawPath ?? '.'));
	return target && resolvedRoot && isPathInWorkspace(target, resolvedRoot) ? target : null;
}

export function buildGrepTools(workspaceRoot: string, ctx?: WorktreeToolContext): PortalTool[] {
	const treeFor = createTreeResolver(workspaceRoot, ctx);
	const permissionRoot = (worktree: string | undefined) =>
		worktree ? resolveWorktreeDir(worktree, ctx) : workspaceRoot;

	return [
		{
			name: 'grep',
			description:
				'Search workspace text with a bounded regular expression. Returns matching files, line numbers, and snippets; use path and glob to narrow the search. Searches stay inside the selected workspace or held worktree.',
			argsSchema: GrepArgs,
			parameters: {
				type: 'object',
				properties: {
					pattern: { type: 'string', description: 'Regular expression to search for.' },
					path: { type: 'string', description: 'Optional workspace-relative file or directory.' },
					glob: { type: 'string', description: 'Optional file glob, such as **/*.ts.' },
					contextLines: { type: 'number', description: 'Lines of context around each match.' },
					maxMatches: { type: 'number', description: 'Maximum matches to return.' },
					caseSensitive: { type: 'boolean', description: 'Whether matching is case-sensitive.' },
					worktree: WORKTREE_PARAM
				},
				required: ['pattern'],
				additionalProperties: false
			},
			derivePermissionRequest(args): ToolPermissionRequest | null {
				const parsed = GrepArgs.safeParse(args);
				if (!parsed.success) return null;
				const root = permissionRoot(parsed.data.worktree);
				const path = root && resolveTarget(root, parsed.data.path);
				return path ? { permissionKind: 'read', path } : null;
			},
			async handler(args) {
				const parsed = GrepArgs.parse(args);
				const tree = treeFor(parsed.worktree);
				if (tree.error) return tree.error;
				const target = resolveTarget(tree.cwd, parsed.path);
				if (!target) return err('path must resolve inside the workspace', { code: 'invalid_path' });
				const rgArgs = [
					'--no-heading',
					'--line-number',
					'--color',
					'never',
					'--max-count',
					String(parsed.maxMatches)
				];
				if (!parsed.caseSensitive) rgArgs.push('--ignore-case');
				if (parsed.contextLines) rgArgs.push('--context', String(parsed.contextLines));
				if (parsed.glob) rgArgs.push('--glob', parsed.glob);
				rgArgs.push(parsed.pattern, target);
				try {
					const { code, stdout, stderr } = await ripgrep(rgArgs, {
						buffer: true,
						nodeWasi: false,
						preopens: { '.': tree.cwd }
					});
					const buffered = Buffer.from(stdout + stderr);
					const truncated = buffered.length > MAX_GREP_OUTPUT_BYTES;
					const output = buffered.subarray(0, MAX_GREP_OUTPUT_BYTES).toString('utf8');
					if (code !== 0 && code !== 1)
						return err(output || 'grep failed', { code: 'grep_failed' });
					return ok({ output, matches: code === 0, truncated }, 'Search completed.');
				} catch (error) {
					return err(error instanceof Error ? error.message : String(error), {
						code: 'grep_failed'
					});
				}
			}
		}
	];
}
