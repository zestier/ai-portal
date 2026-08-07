import { relative, resolve } from 'node:path';
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
const MAX_LIST_FILES = 5_000;
const GrepOutput = z.enum(['content', 'lines', 'files']);
const GrepArgs = z
	.object({
		pattern: z.string().min(1).max(4096),
		path: z.string().min(1).max(4096).optional(),
		glob: z.string().max(512).optional(),
		contextLines: z.number().int().min(0).max(20).optional().default(0),
		maxMatches: z.number().int().min(1).max(500).optional().default(100),
		caseSensitive: z.boolean().optional().default(true),
		output: GrepOutput.optional().default('content'),
		worktree: WorktreeSelector
	})
	.strict();

const ListFilesArgs = z
	.object({
		path: z.string().min(1).max(4096).optional(),
		glob: z.array(z.string().min(1).max(512)).max(20).optional(),
		hidden: z.boolean().optional().default(false),
		maxResults: z.number().int().min(1).max(MAX_LIST_FILES).optional().default(500),
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
			name: 'list_files',
			description:
				'List files with ripgrep semantics. Respects .gitignore and other ignore files by default, returns workspace-relative paths, and supports include or exclude globs (prefix exclusions with !). Use path to limit traversal, hidden to include hidden files, and maxResults to bound output.',
			argsSchema: ListFilesArgs,
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Optional workspace-relative file or directory.' },
					glob: {
						type: 'array',
						items: { type: 'string' },
						description:
							'Optional ripgrep globs. Pass multiple patterns to combine them; prefix exclusions with !.'
					},
					hidden: { type: 'boolean', description: 'Include hidden files and directories.' },
					maxResults: { type: 'number', description: 'Maximum file paths to return.' },
					worktree: WORKTREE_PARAM
				},
				additionalProperties: false
			},
			derivePermissionRequest(args): ToolPermissionRequest | null {
				const parsed = ListFilesArgs.safeParse(args);
				if (!parsed.success) return null;
				const root = permissionRoot(parsed.data.worktree);
				const path = root && resolveTarget(root, parsed.data.path);
				return path ? { permissionKind: 'read', path } : null;
			},
			async handler(args) {
				const parsed = ListFilesArgs.parse(args);
				const tree = treeFor(parsed.worktree);
				if (tree.error) return tree.error;
				const target = resolveTarget(tree.cwd, parsed.path);
				if (!target) return err('path must resolve inside the workspace', { code: 'invalid_path' });
				const rgArgs = ['--files', '--no-require-git'];
				if (parsed.hidden) rgArgs.push('--hidden');
				for (const glob of parsed.glob ?? []) rgArgs.push('--glob', glob);
				rgArgs.push(target);
				try {
					const { code, stdout, stderr } = await ripgrep(rgArgs, {
						buffer: true,
						nodeWasi: false,
						preopens: { '.': tree.cwd }
					});
					if (code !== 0 && code !== 1) {
						return err(stderr || stdout || 'file listing failed', { code: 'list_files_failed' });
					}
					const allFiles = stdout
						.split(/\r?\n/)
						.filter(Boolean)
						.map((file) => relative(tree.cwd, file).replaceAll('\\', '/'))
						.sort();
					const files = allFiles.slice(0, parsed.maxResults);
					return ok(
						{ files, count: files.length, truncated: allFiles.length > files.length },
						`Listed ${files.length} file(s).`
					);
				} catch (error) {
					return err(error instanceof Error ? error.message : String(error), {
						code: 'list_files_failed'
					});
				}
			}
		},
		{
			name: 'grep',
			description:
				'Search workspace text with a bounded regular expression. The output mode controls whether results include matching content (content, the default), only file and line locations (lines), or only unique matching files (files). Context lines apply only to content output. Use path and glob to narrow the search. Searches stay inside the selected workspace or held worktree.',
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
					output: {
						type: 'string',
						enum: GrepOutput.options,
						description:
							'Result detail: content includes snippets, lines returns file:line locations, and files returns unique file paths.'
					},
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
				const rgArgs = ['--color', 'never', '--max-count', String(parsed.maxMatches)];
				if (parsed.output === 'files') rgArgs.push('--files-with-matches');
				else rgArgs.push('--no-heading', '--line-number');
				if (!parsed.caseSensitive) rgArgs.push('--ignore-case');
				if (parsed.output === 'content' && parsed.contextLines) {
					rgArgs.push('--context', String(parsed.contextLines));
				}
				if (parsed.glob) rgArgs.push('--glob', parsed.glob);
				rgArgs.push(parsed.pattern, target);
				try {
					const { code, stdout, stderr } = await ripgrep(rgArgs, {
						buffer: true,
						nodeWasi: false,
						preopens: { '.': tree.cwd }
					});
					let rawOutput = stdout;
					if (parsed.output === 'lines') {
						rawOutput =
							stdout
								.split(/\r?\n/)
								.filter(Boolean)
								.map((line) => {
									const match = /^(.*):(\d+):/.exec(line);
									if (!match) return line;
									return `${relative(tree.cwd, match[1]).replaceAll('\\', '/')}:${match[2]}`;
								})
								.join('\n') + (stdout.endsWith('\n') ? '\n' : '');
					} else if (parsed.output === 'files') {
						rawOutput =
							stdout
								.split(/\r?\n/)
								.filter(Boolean)
								.map((file) => relative(tree.cwd, file).replaceAll('\\', '/'))
								.join('\n') + (stdout.endsWith('\n') ? '\n' : '');
					}
					const buffered = Buffer.from(rawOutput + stderr);
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
