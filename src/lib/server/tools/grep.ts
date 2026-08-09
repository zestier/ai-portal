import { performance } from 'node:perf_hooks';
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
const GrepOutputMode = z.enum(['content', 'files_with_matches', 'count']);

// Mirrors the Agent SDK's GrepInput so the aliased SDK `Grep` tool (which sends
// these field names verbatim) parses cleanly.
const GrepArgs = z
	.object({
		pattern: z.string().min(1).max(4096),
		path: z.string().min(1).max(4096).optional(),
		glob: z.string().max(512).optional(),
		output_mode: GrepOutputMode.optional().default('files_with_matches'),
		'-B': z.number().int().min(0).optional(),
		'-A': z.number().int().min(0).optional(),
		'-C': z.number().int().min(0).optional(),
		context: z.number().int().min(0).optional(),
		'-n': z.boolean().optional().default(true),
		'-i': z.boolean().optional().default(false),
		'-o': z.boolean().optional().default(false),
		type: z.string().max(64).optional(),
		head_limit: z.number().int().min(0).optional().default(250),
		offset: z.number().int().min(0).optional().default(0),
		multiline: z.boolean().optional().default(false),
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

type GrepArgsParsed = z.infer<typeof GrepArgs>;

// The portal's projection of the SDK GrepOutput contract, plus an internal
// `truncated` flag for when the 100KB output cap bit (the SDK has no field for
// it, so the renderer surfaces it as a marker). Fields the search cannot
// cheaply derive (content-mode per-file stats) are simply omitted.
export interface GrepResult {
	mode: 'content' | 'files_with_matches' | 'count';
	numFiles?: number;
	filenames?: string[];
	content?: string;
	numLines?: number;
	numMatches?: number;
	totalFiles?: number;
	totalLines?: number;
	appliedLimit?: number;
	appliedOffset?: number;
	truncated?: boolean;
}

function resolveTarget(root: string, rawPath: string | undefined): string | null {
	const resolvedRoot = resolveWithParentFallback(resolve(root));
	const target = resolveWithParentFallback(resolve(resolvedRoot ?? root, rawPath ?? '.'));
	return target && resolvedRoot && isPathInWorkspace(target, resolvedRoot) ? target : null;
}

// Truncate a filename list so the joined output stays under `maxBytes`; the
// byte cap mirrors the old bounded-output guarantee (no GrepOutput field
// carries it, so the renderer appends a marker when `truncated` is true).
function capList(paths: string[], maxBytes: number): { paths: string[]; truncated: boolean } {
	const out: string[] = [];
	let len = 0;
	for (const p of paths) {
		const added = Buffer.byteLength(p) + (out.length > 0 ? 1 : 0);
		if (len + added > maxBytes) return { paths: out, truncated: true };
		out.push(p);
		len += added;
	}
	return { paths: out, truncated: false };
}

function capContent(text: string, maxBytes: number): { text: string; truncated: boolean } {
	const buf = Buffer.from(text, 'utf8');
	if (buf.length <= maxBytes) return { text, truncated: false };
	return {
		text: buf.subarray(0, maxBytes).toString('utf8') + '\n...[truncated: results exceed 100KB]',
		truncated: true
	};
}

function relativePath(cwd: string, p: string): string {
	return relative(cwd, p).replaceAll('\\', '/');
}

// Content lines are prefixed with the path exactly as rg was given it, which
// is the absolute `target`. Relativize that prefix (and drop rg's `./` for a
// `.` target) so output is workspace-relative like files/count modes.
function relativizeContentLine(cwd: string, line: string): string {
	const abs = cwd.replace(/\/+$/, '') + '/';
	if (line.startsWith(abs)) return line.slice(abs.length);
	return line.startsWith('./') ? line.slice(2) : line;
}

function capEntries(
	entries: { path: string; count: number }[],
	maxBytes: number
): { entries: { path: string; count: number }[]; truncated: boolean } {
	const out: { path: string; count: number }[] = [];
	let len = 0;
	for (const e of entries) {
		const added = Buffer.byteLength(e.path) + (out.length > 0 ? 1 : 0);
		if (len + added > maxBytes) return { entries: out, truncated: true };
		out.push(e);
		len += added;
	}
	return { entries: out, truncated: false };
}

async function searchGrep(cwd: string, target: string, args: GrepArgsParsed): Promise<GrepResult> {
	const mode = args.output_mode;
	const rgArgs = ['--color', 'never'];
	if (mode === 'files_with_matches') {
		rgArgs.push('--files-with-matches');
	} else if (mode === 'count') {
		rgArgs.push('--count-matches');
	} else {
		// content: rg-style path:line:content, one match per line.
		rgArgs.push('--no-heading', '--with-filename');
		if (args['-n']) rgArgs.push('--line-number');
		if (args['-o']) rgArgs.push('--only-matching');
	}
	if (args['-i']) rgArgs.push('--ignore-case');
	if (args.multiline) rgArgs.push('--multiline');
	const ctx = args.context ?? args['-C'] ?? 0;
	const before = args['-B'] ?? ctx;
	const after = args['-A'] ?? ctx;
	if (before > 0) rgArgs.push('--before-context', String(before));
	if (after > 0) rgArgs.push('--after-context', String(after));
	if (args.type) rgArgs.push('--type', args.type);
	if (args.glob) rgArgs.push('--glob', args.glob);
	rgArgs.push(args.pattern, target);

	const { code, stdout, stderr } = await ripgrep(rgArgs, {
		buffer: true,
		nodeWasi: false,
		preopens: { '.': cwd }
	});
	if (code !== 0 && code !== 1) {
		throw new Error(stderr || stdout || 'grep failed');
	}

	const head = args.head_limit > 0 ? args.offset + args.head_limit : undefined;
	const appliedLimit = args.head_limit > 0 ? args.head_limit : undefined;
	const appliedOffset = args.offset > 0 ? args.offset : undefined;

	if (mode === 'content') {
		const lines = stdout.split(/\r?\n/);
		if (lines[lines.length - 1] === '') lines.pop();
		const relLines = lines.map((line) => relativizeContentLine(cwd, line));
		const sliced = relLines.slice(args.offset, head);
		const { text, truncated } = capContent(sliced.join('\n'), MAX_GREP_OUTPUT_BYTES);
		return {
			mode,
			content: text, // capContent embeds the truncation marker
			numLines: sliced.length,
			totalLines: lines.length,
			...(appliedLimit !== undefined ? { appliedLimit } : {}),
			...(appliedOffset !== undefined ? { appliedOffset } : {}),
			...(truncated ? { truncated: true } : {})
		};
	}

	const rawPaths = stdout
		.split(/\r?\n/)
		.filter(Boolean)
		.map((p) => relativePath(cwd, p));
	const totalFiles = rawPaths.length;
	const sliced = rawPaths.slice(args.offset, head);
	const { paths: files, truncated } = capList(sliced, MAX_GREP_OUTPUT_BYTES);

	if (mode === 'files_with_matches') {
		return {
			mode,
			numFiles: files.length,
			filenames: files,
			totalFiles,
			...(appliedLimit !== undefined ? { appliedLimit } : {}),
			...(appliedOffset !== undefined ? { appliedOffset } : {}),
			...(truncated ? { truncated: true } : {})
		};
	}

	// count: per-file counts from `path:count` (or a bare `count` when the
	// target is a single file).
	const rawEntries = stdout
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => {
			const match = /^(.*):(\d+)$/.exec(line);
			if (match) {
				return { path: relativePath(cwd, match[1]), count: Number.parseInt(match[2], 10) };
			}
			return { path: relativePath(cwd, target), count: Number.parseInt(line, 10) };
		});
	const totalLines = rawEntries.reduce((sum, e) => sum + e.count, 0);
	const slicedEntries = rawEntries.slice(args.offset, head);
	const { entries: kept, truncated: capped } = capEntries(slicedEntries, MAX_GREP_OUTPUT_BYTES);
	const numMatches = kept.reduce((sum, e) => sum + e.count, 0);
	return {
		mode,
		numFiles: kept.length,
		filenames: kept.map((e) => e.path),
		numMatches,
		totalFiles: rawEntries.length,
		totalLines,
		...(appliedLimit !== undefined ? { appliedLimit } : {}),
		...(appliedOffset !== undefined ? { appliedOffset } : {}),
		...(capped ? { truncated: true } : {})
	};
}

// The text a model sees for a GrepOutput, mirroring the SDK's rendering so the
// golden conformance suite can compare byte-for-byte.
export function renderGrepResult(result: GrepResult): string {
	if (result.mode === 'count') {
		if ((result.numMatches ?? 0) === 0) {
			return 'No matches found\n\nFound 0 total occurrences across 0 files.';
		}
		return `Found ${result.numMatches} total occurrences across ${result.numFiles ?? 0} files.`;
	}
	if (result.mode === 'content') {
		return result.content ?? '';
	}
	const numFiles = result.numFiles ?? 0;
	const lines = [`Found ${numFiles} file${numFiles === 1 ? '' : 's'}`];
	if (result.filenames && result.filenames.length > 0) lines.push(...result.filenames);
	if (result.truncated) lines.push('[truncated: results exceed 100KB]');
	return lines.join('\n');
}

// Run a Grep call against a plain workspace directory and render its model text
// (used by the golden conformance registry; the tool handler reuses
// `searchGrep` + `renderGrepResult`).
export async function renderGrepModelText(
	args: Record<string, unknown>,
	cwd: string
): Promise<string> {
	const parsed = GrepArgs.parse(args);
	const target = resolveTarget(cwd, parsed.path);
	if (!target) throw new Error('path must resolve inside the workspace');
	return renderGrepResult(await searchGrep(cwd, target, parsed));
}

const MAX_GLOB_FILES = 100;

// Mirrors the Agent SDK's GlobInput so the aliased SDK `Glob` tool (which sends
// these field names verbatim) parses cleanly.
const GlobArgs = z
	.object({
		pattern: z.string().min(1).max(4096),
		path: z.string().min(1).max(4096).optional(),
		worktree: WorktreeSelector
	})
	.strict();

type GlobArgsParsed = z.infer<typeof GlobArgs>;

// The portal's projection of the SDK GlobOutput contract. `totalMatches` is the
// exact pre-cap count and `countIsComplete` is always true because rg lists
// every match up front (the 100-file bound is applied here, not inside rg).
export interface GlobResult {
	durationMs: number;
	numFiles: number;
	filenames: string[];
	truncated: boolean;
	totalMatches: number;
	countIsComplete: boolean;
}

// The text a model sees for a GlobOutput, mirroring the SDK's rendering so the
// golden conformance suite can compare byte-for-byte.
export function renderGlobResult(result: GlobResult): string {
	if (result.filenames.length === 0) return 'No files found';
	return result.filenames.join('\n');
}

async function searchGlob(cwd: string, target: string, args: GlobArgsParsed): Promise<GlobResult> {
	const started = performance.now();
	// The SDK's Glob walks the filesystem without consulting ignore files — the
	// `Glob/ignored` golden lists a gitignored node_modules file — so `--no-ignore`
	// (and `--hidden`) mirror that. Sorted output is a deliberate divergence from
	// the SDK's filesystem-dependent traversal order, kept for determinism the
	// way list_files sorts.
	const rgArgs = ['--files', '--hidden', '--no-ignore', '--glob', args.pattern, target];
	const { code, stdout, stderr } = await ripgrep(rgArgs, {
		buffer: true,
		nodeWasi: false,
		preopens: { '.': cwd }
	});
	if (code !== 0 && code !== 1) {
		throw new Error(stderr || stdout || 'glob failed');
	}
	const filenames = stdout
		.split(/\r?\n/)
		.filter(Boolean)
		.map((p) => relativePath(cwd, p))
		.sort();
	const totalMatches = filenames.length;
	return {
		durationMs: Math.round(performance.now() - started),
		numFiles: Math.min(totalMatches, MAX_GLOB_FILES),
		filenames: filenames.slice(0, MAX_GLOB_FILES),
		truncated: totalMatches > MAX_GLOB_FILES,
		totalMatches,
		countIsComplete: true
	};
}

// Run a Glob call against a plain workspace directory and render its model text
// (used by the golden conformance registry; the tool handler reuses
// `searchGlob` + `renderGlobResult`).
export async function renderGlobModelText(
	args: Record<string, unknown>,
	cwd: string
): Promise<string> {
	const parsed = GlobArgs.parse(args);
	const target = resolveTarget(cwd, parsed.path);
	if (!target) throw new Error('path must resolve inside the workspace');
	return renderGlobResult(await searchGlob(cwd, target, parsed));
}

export function buildGrepTools(workspaceRoot: string, ctx?: WorktreeToolContext): PortalTool[] {
	const treeFor = createTreeResolver(workspaceRoot, ctx);
	const permissionRoot = (worktree: string | undefined) =>
		worktree ? resolveWorktreeDir(worktree, ctx) : workspaceRoot;

	return [
		{
			name: 'list_files',
			description:
				'List files with ripgrep semantics. Respects .gitignore by default, returns workspace-relative paths, supports include/exclude globs (prefix exclusions with !). Use `path` to limit traversal, `hidden` for hidden files, `maxResults` to bound output.',
			argsSchema: ListFilesArgs,
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Workspace-relative file or directory.' },
					glob: {
						type: 'array',
						items: { type: 'string' },
						description: 'Ripgrep globs; prefix exclusions with !.'
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
						.map((file) => relativePath(tree.cwd, file))
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
				'Search workspace text with ripgrep. output_mode: "content" (matching lines with -B/-A/-C context and line numbers), "files_with_matches" (unique file paths), or "count" (per-file match counts). head_limit/offset bound results; `path` limits traversal; `glob`/`type` filter files. Respects .gitignore. Stays inside the selected workspace or held worktree.',
			argsSchema: GrepArgs,
			parameters: {
				type: 'object',
				properties: {
					pattern: { type: 'string', description: 'Regular expression to search for.' },
					path: { type: 'string', description: 'Workspace-relative file or directory.' },
					glob: { type: 'string', description: 'File glob, e.g. **/*.ts.' },
					output_mode: {
						type: 'string',
						enum: GrepOutputMode.options,
						description: 'content | files_with_matches | count (see tool description).'
					},
					'-B': {
						type: 'number',
						description: 'Context lines before each match (content mode).'
					},
					'-A': {
						type: 'number',
						description: 'Context lines after each match (content mode).'
					},
					'-C': {
						type: 'number',
						description: 'Context lines before and after each match (content mode).'
					},
					context: {
						type: 'number',
						description: 'Context lines before and after each match (content mode).'
					},
					'-n': { type: 'boolean', description: 'Show line numbers in content mode.' },
					'-i': { type: 'boolean', description: 'Case-insensitive matching.' },
					'-o': {
						type: 'boolean',
						description: 'Only matched parts, one per line (content mode).'
					},
					type: {
						type: 'string',
						description: 'File type to search (rg --type), e.g. js, py.'
					},
					head_limit: {
						type: 'number',
						description: 'First N lines/entries; 0 unlimited.'
					},
					offset: {
						type: 'number',
						description: 'Skip N lines/entries before head_limit.'
					},
					multiline: { type: 'boolean', description: 'Enable multiline matching.' },
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
				try {
					const result = await searchGrep(tree.cwd, target, parsed);
					return ok(result, 'Search completed.', {
						views: [{ type: 'text', text: renderGrepResult(result) }]
					});
				} catch (error) {
					return err(error instanceof Error ? error.message : String(error), {
						code: 'grep_failed'
					});
				}
			}
		},
		{
			name: 'glob',
			description:
				'List files matching a glob pattern (ripgrep glob). `path` optionally limits the search root (default workspace root). Does NOT respect .gitignore; use list_files for ignore-aware listings. Returns workspace-relative paths, capped at 100 files. Stays inside the selected workspace or held worktree.',
			argsSchema: GlobArgs,
			parameters: {
				type: 'object',
				properties: {
					pattern: { type: 'string', description: 'Glob pattern to match.' },
					path: {
						type: 'string',
						description: 'Workspace-relative file or directory to search in.'
					},
					worktree: WORKTREE_PARAM
				},
				required: ['pattern'],
				additionalProperties: false
			},
			derivePermissionRequest(args): ToolPermissionRequest | null {
				const parsed = GlobArgs.safeParse(args);
				if (!parsed.success) return null;
				const root = permissionRoot(parsed.data.worktree);
				const path = root && resolveTarget(root, parsed.data.path);
				return path ? { permissionKind: 'read', path } : null;
			},
			async handler(args) {
				const parsed = GlobArgs.parse(args);
				const tree = treeFor(parsed.worktree);
				if (tree.error) return tree.error;
				const target = resolveTarget(tree.cwd, parsed.path);
				if (!target) return err('path must resolve inside the workspace', { code: 'invalid_path' });
				try {
					const result = await searchGlob(tree.cwd, target, parsed);
					return ok(result, 'Search completed.', {
						views: [{ type: 'text', text: renderGlobResult(result) }]
					});
				} catch (error) {
					return err(error instanceof Error ? error.message : String(error), {
						code: 'glob_failed'
					});
				}
			}
		}
	];
}
