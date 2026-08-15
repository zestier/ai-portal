// Experiment (token-experiment branch, T38): pure-indentation structural
// outline logic. No per-language keyword list — a block header is any
// non-blank line followed by a deeper-indented line, so it works in C/Python/
// JS/Rust/etc. without knowing the language. Consumed by the `read` tool
// (mode auto/outline) so the model can navigate a file without reading it
// whole. The standalone outline tool was folded into `read` during
// consolidation.
//
// Known gaps (deliberate, `ponytail:` ceiling — add a decl-keyword filter or a
// real parser only if measurements show the outline misses too much):
// - single-line declarations (no indent change) are invisible;
// - depth ≤ 1 hides helpers nested 2+ levels;
// - multi-line signatures / mixed tabs-and-spaces are best-effort.
const MAX_HEADER_LINES = 20;
const MAX_TAIL_LINES = 10;
const MAX_BLOCKS = 80;
// A line longer than this flags the file as minified/one-giant-line: no indent
// structure, callers fall back to a full (paged) read.
const MAX_LINE_CHARS = 2000;
const TAB_WIDTH = 4;

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

// The identity line (path, line count, size, hash) is the caller's banner; this
// renders only structure. Blocks are top-level (depth 0) only and any block
// whose body is already in the tail range is skipped — the model drills into a
// listed block's extent, it never needs a block re-shown as an index entry.
export function renderOutline(o: FileOutline): string {
	const out: string[] = [];
	if (o.headerLines.length > 0) {
		out.push(`header (1-${o.headerLines.length}):`);
		out.push(...o.headerLines.map((l, i) => `${i + 1}\t${l}`));
	}
	const tailStart = o.totalLines - o.tailLines.length + 1;
	const blocks = o.blocks.filter((b) => b.depth === 0 && b.line < tailStart);
	if (blocks.length > 0) {
		out.push('blocks (top-level; line-extent):');
		for (const b of blocks) {
			out.push(`${String(b.line).padStart(4)}\t${b.text}  (${b.line}-${b.extent})`);
		}
		if (o.truncatedBlocks > 0) out.push(`… ${o.truncatedBlocks} more blocks`);
	}
	if (o.tailLines.length > 0) {
		out.push(`tail (${tailStart}-${o.totalLines}):`);
		out.push(...o.tailLines.map((l, i) => `${tailStart + i}\t${l}`));
	}
	out.push(
		"Outline only — read an offset:limit range for a block body, or mode:'content' for raw."
	);
	return out.join('\n');
}
