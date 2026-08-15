// Experiment (token-experiment branch, T38): a pure-indentation structural
// outline for large files. No per-language keyword list — a block header is any
// non-blank line followed by a deeper-indented line, so it works in C/Python/
// JS/Rust/etc. without knowing the language. The point is to let the model
// navigate a bloated file without reading the whole thing.
//
// Known gaps (deliberate, `ponytail:` ceiling — add a decl-keyword filter or a
// real parser only if measurements show the outline misses too much):
// - single-line declarations (no indent change) are invisible;
// - depth ≤ 1 hides helpers nested 2+ levels;
// - multi-line signatures / mixed tabs-and-spaces are best-effort.
import { stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sniffImageMime } from '../image-detect';
import { resolveReadTarget, readFileResult } from './read';
import { err, ok, type PortalTool, type ToolPermissionRequest, type ToolResult } from './types';
import {
	createTreeResolver,
	resolveWorktreeDir,
	WorktreeSelector,
	WORKTREE_PARAM,
	type WorktreeToolContext
} from './worktree-selector';
import { resolveAbsoluteTarget } from './filesystem';

const MAX_OUTLINE_FILE_BYTES = 5_000_000;
// Below this line count the file is cheaper to read whole; the handler
// delegates to the normal read tool instead of outlining.
const SMALL_FILE_LINES = 40;
const MAX_HEADER_LINES = 20;
const MAX_TAIL_LINES = 10;
const MAX_BLOCKS = 80;
// A line longer than this flags the file as minified/one-giant-line: no indent
// structure, fall back to a full (paged) read.
const MAX_LINE_CHARS = 2000;
const TAB_WIDTH = 4;

const OutlineArgs = z
	.object({
		file_path: z.string().min(1).max(4096),
		worktree: WorktreeSelector
	})
	.strict();

export interface OutlineBlock {
	/** 1-indexed header line (the declaration line, after `{`-merge). */
	line: number;
	/** Indent level, 0 = top level, normalized across indent widths. */
	depth: number;
	/** Header text, trimmed. */
	text: string;
	/** Last line of the block (inclusive), best-effort. */
	extent: number;
}

export interface FileOutline {
	format: 'normal' | 'minified' | 'flat';
	totalLines: number;
	headerLines: string[];
	tailLines: string[];
	blocks: OutlineBlock[];
	truncatedBlocks: number;
}

function indentWidth(line: string): number {
	let w = 0;
	for (const ch of line) {
		if (ch === ' ') w += 1;
		else if (ch === '\t') w += TAB_WIDTH;
		else break;
	}
	return w;
}

export function computeOutline(content: string): FileOutline {
	const lines = content.split(/\r?\n/);
	const totalLines = lines.length;
	const headerLines = lines.slice(0, MAX_HEADER_LINES);
	const tailLines = lines.slice(-MAX_TAIL_LINES);

	for (const line of lines) {
		if (line.length > MAX_LINE_CHARS) {
			return {
				format: 'minified',
				totalLines,
				headerLines,
				tailLines,
				blocks: [],
				truncatedBlocks: 0
			};
		}
	}

	const nonBlank: { i: number; indent: number }[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim().length === 0) continue;
		nonBlank.push({ i, indent: indentWidth(lines[i]) });
	}

	// Normalize observed indent widths to levels (0,1,2…) so 2-space, 4-space
	// and tab files all behave the same. A single distinct width = no nesting.
	const widths = [...new Set(nonBlank.map((n) => n.indent))].sort((a, b) => a - b);
	if (widths.length <= 1) {
		return {
			format: 'flat',
			totalLines,
			headerLines,
			tailLines,
			blocks: [],
			truncatedBlocks: 0
		};
	}
	const levelOf = new Map(widths.map((w, idx) => [w, idx]));

	const blocks: OutlineBlock[] = [];
	for (let k = 0; k < nonBlank.length; k++) {
		const cur = nonBlank[k];
		const next = nonBlank[k + 1];
		// Block header: this line opens a deeper-indented region.
		if (!next || next.indent <= cur.indent) continue;
		const depth = levelOf.get(cur.indent)!;
		if (depth > 1) continue; // keep top level + one nested (class methods)

		let line = cur.i + 1;
		let text = lines[cur.i].trim();
		// A block opener that starts with a closing delimiter is a multi-line
		// signature/chain continuation (`): Type {` after `name(`, `}` after a
		// brace), not a real block — skip it. No language keywords involved.
		if (/^[)\]}]/.test(text)) continue;
		// Allman/BSD style: `{` sits alone under the declaration. Attach the
		// declaration so the outline names the block instead of a bare brace.
		if (text.startsWith('{')) {
			const prev = nonBlank[k - 1];
			if (prev) {
				line = prev.i + 1;
				text = `${lines[prev.i].trim()} {`;
			}
		}

		// Extent = last body line (1-based). The first later non-blank line at
		// or above the header's indent closes the block; its 0-based index IS
		// the 1-based number of the line just before it. No closer → to EOF.
		let extent = totalLines;
		for (let j = k + 1; j < nonBlank.length; j++) {
			if (nonBlank[j].indent <= cur.indent) {
				extent = nonBlank[j].i;
				break;
			}
		}
		blocks.push({ line, depth, text, extent });
	}

	let truncatedBlocks = 0;
	if (blocks.length > MAX_BLOCKS) {
		truncatedBlocks = blocks.length - MAX_BLOCKS;
		blocks.length = MAX_BLOCKS;
	}
	return { format: 'normal', totalLines, headerLines, tailLines, blocks, truncatedBlocks };
}

export function renderOutline(rel: string, o: FileOutline, size: number, hash: string): string {
	const out: string[] = [];
	out.push(
		`outline: ${rel} — ${o.totalLines} lines, ${size} bytes, format ${o.format}, hash ${hash}`
	);
	if (o.headerLines.length > 0) {
		out.push(`header (1-${o.headerLines.length}):`);
		out.push(...o.headerLines.map((l, i) => `${i + 1}\t${l}`));
	}
	if (o.blocks.length > 0) {
		out.push('blocks (depth 0 = top level; line-extent):');
		for (const b of o.blocks) {
			out.push(
				`${String(b.line).padStart(4)}\t${'  '.repeat(b.depth)}${b.text}  (${b.line}-${b.extent})`
			);
		}
		if (o.truncatedBlocks > 0) out.push(`… ${o.truncatedBlocks} more blocks (depth ≤ 1)`);
	}
	const tailStart = o.totalLines - o.tailLines.length + 1;
	if (o.tailLines.length > 0) {
		out.push(`tail (${tailStart}-${o.totalLines}):`);
		out.push(...o.tailLines.map((l, i) => `${tailStart + i}\t${l}`));
	}
	out.push('Outline only — read an offset:limit range to see a block body.');
	return out.join('\n');
}

async function outlineResult(cwd: string, filePath: string): Promise<ToolResult> {
	const resolved = resolveReadTarget(cwd, filePath);
	if (!resolved.ok) return err(resolved.message);
	const { abs, rel } = resolved;
	try {
		const fileStat = await stat(abs);
		if (fileStat.isDirectory()) {
			return err(`Path is a directory, not a file: ${rel}`);
		}
		if (fileStat.size > MAX_OUTLINE_FILE_BYTES) {
			return err(
				`File is too large to outline safely (${fileStat.size} bytes; limit is ${MAX_OUTLINE_FILE_BYTES}).`
			);
		}
		const buf = await readFile(abs);
		const sniffed = sniffImageMime(buf.subarray(0, 16));
		if (sniffed !== null) {
			return readFileResult(cwd, filePath, { offset: 1, limit: Number.MAX_SAFE_INTEGER });
		}
		const content = buf.toString('utf8');
		if (content.includes('\0')) {
			return err(`File contains null bytes and is likely binary: ${rel}`);
		}
		const totalLines = content.split(/\r?\n/).length;
		if (totalLines <= SMALL_FILE_LINES) {
			return readFileResult(cwd, filePath, { offset: 1, limit: totalLines });
		}
		const outline = computeOutline(content);
		if (outline.format !== 'normal') {
			return readFileResult(cwd, filePath, { offset: 1, limit: totalLines });
		}
		const hash = createHash('sha1').update(content).digest('hex').slice(0, 8);
		const body = renderOutline(rel, outline, fileStat.size, hash);
		return ok(
			{
				type: 'text',
				file: {
					filePath: rel,
					totalLines: outline.totalLines,
					size: fileStat.size,
					format: outline.format,
					header: outline.headerLines,
					tail: outline.tailLines,
					blocks: outline.blocks,
					truncatedBlocks: outline.truncatedBlocks,
					hash,
					mtimeMs: fileStat.mtimeMs
				}
			},
			`Outline file: ${rel}`,
			{ views: [{ type: 'text', text: body }] }
		);
	} catch (e) {
		if (e instanceof Error && 'code' in e && e.code === 'ENOENT') {
			return err(`File does not exist. Note: your current working directory is ${cwd}.`);
		}
		return err(e instanceof Error ? e.message : String(e));
	}
}

export function buildOutlineTools(workspaceRoot: string, ctx?: WorktreeToolContext): PortalTool[] {
	const treeFor = createTreeResolver(workspaceRoot, ctx);
	const permissionRoot = (worktree: string | undefined) =>
		worktree ? resolveWorktreeDir(worktree, ctx) : workspaceRoot;

	return [
		{
			name: 'outline',
			description:
				'Return a structural outline of a large file (indentation-based blocks, no full content) so you can navigate to the parts you need without reading the whole file.',
			promptGuidelines: [
				'Small files (≤40 lines), minified files, and images return the full read result instead of an outline.',
				'`blocks` list block headers at depth ≤ 1 with line ranges; read a specific offset:limit range when you need a block body.',
				"Line numbers go stale after edits — re-outline or use an edit tool's shift report before navigating to a saved line."
			],
			argsSchema: OutlineArgs,
			parameters: {
				type: 'object',
				properties: {
					file_path: {
						type: 'string',
						description: 'Path (absolute or workspace-relative).'
					},
					worktree: WORKTREE_PARAM
				},
				required: ['file_path'],
				additionalProperties: false
			},
			derivePermissionRequest(args): ToolPermissionRequest | null {
				const parsed = OutlineArgs.safeParse(args);
				if (!parsed.success) return null;
				const root = permissionRoot(parsed.data.worktree);
				if (root === null) return null;
				const abs = resolveAbsoluteTarget(root, parsed.data.file_path);
				if (abs === null) return null;
				return { permissionKind: 'read', path: abs };
			},
			async handler(args) {
				const parsed = OutlineArgs.parse(args);
				const tree = treeFor(parsed.worktree);
				if (tree.error) return tree.error;
				return outlineResult(tree.cwd, parsed.file_path);
			}
		}
	];
}
