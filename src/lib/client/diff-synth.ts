import { createTwoFilesPatch } from 'diff';

// Synthesize a unified-diff string from the arguments of file-mutation tool
// calls (create, edit, write_file, etc.) so the existing DiffView component
// can render the change. The pi SDK doesn't always emit a structured
// diff in the tool result; the args themselves contain enough information
// to reconstruct one.
//
// We delegate the actual diff math to `jsdiff` so the output has proper
// LCS-based context lines instead of marking every line in the edit block
// as changed. The library prepends an `Index:` / `===` header that
// `parseUnifiedDiff` doesn't understand, so we strip it.

export interface SynthDiffInput {
	tool: string;
	// May be null when the page payload trimmed oversized args; a synthesized
	// diff simply isn't available then.
	argsJson: string | null;
}

export interface SynthDiff {
	path: string;
	diff: string;
}

interface ParsedArgs {
	[key: string]: unknown;
}

function parseArgs(json: string | null): ParsedArgs | null {
	if (json === null) return null;
	try {
		const v = JSON.parse(json);
		return v && typeof v === 'object' && !Array.isArray(v) ? (v as ParsedArgs) : null;
	} catch {
		return null;
	}
}

function str(v: unknown): string | null {
	return typeof v === 'string' ? v : null;
}

// jsdiff returns a "Index:" / "===" preamble and tab-padded ---/+++ headers
// (GNU diff quirk). Strip the preamble and trim the header whitespace so
// the output matches what `parseUnifiedDiff` expects.
function cleanPatch(patch: string): string {
	const lines = patch.split('\n');
	let i = 0;
	if (lines[i]?.startsWith('Index:')) i += 1;
	if (lines[i]?.startsWith('===')) i += 1;
	const rest = lines.slice(i);
	if (rest[0]?.startsWith('--- ')) rest[0] = rest[0].replace(/\s+$/, '');
	if (rest[1]?.startsWith('+++ ')) rest[1] = rest[1].replace(/\s+$/, '');
	return rest.join('\n');
}

function fromEditArgs(path: string, args: ParsedArgs): SynthDiff | null {
	const oldStr = str(args.old_str) ?? str(args.old_string) ?? str(args.oldText) ?? str(args.search);
	const newStr =
		str(args.new_str) ?? str(args.new_string) ?? str(args.newText) ?? str(args.replace);
	if (oldStr == null || newStr == null) return null;
	const patch = createTwoFilesPatch(`a/${path}`, `b/${path}`, oldStr, newStr, '', '', {
		context: 3
	});
	return { path, diff: cleanPatch(patch) };
}

// `multi_edit` carries its edits as an array of `{file_path, old_string,
// new_string, replace_all?}` objects — the same shape `edit` uses, so each
// entry synthesizes through `fromEditArgs` and the UI shows one sequential diff
// per edit (mirroring how the batch applies).
function fromMultiEditArgs(args: ParsedArgs): SynthDiff[] {
	if (!Array.isArray(args.edits)) return [];
	const diffs: SynthDiff[] = [];
	for (const raw of args.edits) {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
		const entry = raw as ParsedArgs;
		const path = str(entry.file_path) ?? str(entry.path) ?? str(entry.file);
		if (!path) continue;
		const diff = fromEditArgs(path, entry);
		if (diff) diffs.push(diff);
	}
	return diffs;
}

function fromCreateArgs(path: string, args: ParsedArgs): SynthDiff | null {
	const body = str(args.file_text) ?? str(args.content) ?? str(args.contents) ?? str(args.text);
	if (body == null) return null;
	const patch = createTwoFilesPatch('/dev/null', `b/${path}`, '', body, '', '', { context: 3 });
	return { path, diff: cleanPatch(patch) };
}

const EDIT_TOOLS = new Set(['edit']);
const CREATE_TOOLS = new Set(['write']);

export function synthesizeDiffs(input: SynthDiffInput): SynthDiff[] {
	const t = input.tool.toLowerCase();

	const args = parseArgs(input.argsJson);
	if (!args) return [];
	if (t === 'multi_edit') return fromMultiEditArgs(args);

	const path = str(args.path) ?? str(args.file) ?? str(args.filename) ?? str(args.file_path);
	if (!path) return [];
	if (EDIT_TOOLS.has(t)) {
		const diff = fromEditArgs(path, args);
		return diff ? [diff] : [];
	}
	if (CREATE_TOOLS.has(t)) {
		const diff = fromCreateArgs(path, args);
		return diff ? [diff] : [];
	}
	// Be tolerant: some tools accept either shape. Try edit first, fall
	// back to create.
	return [fromEditArgs(path, args) ?? fromCreateArgs(path, args)].filter(
		(v): v is SynthDiff => v != null
	);
}

export function synthesizeDiff(input: SynthDiffInput): SynthDiff | null {
	return synthesizeDiffs(input)[0] ?? null;
}

export function splitUnifiedDiffByFile(diff: string, fallbackPath = 'git diff'): SynthDiff[] {
	if (!looksLikeUnifiedDiff(diff)) return [];
	const lines = diff.split('\n');
	const chunks: string[][] = [];
	let current: string[] = [];
	for (const line of lines) {
		if (line.startsWith('diff --git ') && current.length > 0) {
			chunks.push(current);
			current = [];
		}
		current.push(line);
	}
	if (current.length > 0) chunks.push(current);
	return chunks
		.map((chunk) => {
			const text = chunk.join('\n').replace(/\n$/, '');
			return { path: pathFromDiffChunk(chunk) ?? fallbackPath, diff: text };
		})
		.filter((chunk) => chunk.diff.length > 0);
}

function looksLikeUnifiedDiff(diff: string): boolean {
	return diff.includes('\n@@ ') || diff.startsWith('diff --git ') || diff.includes('\n--- ');
}

function pathFromDiffChunk(lines: string[]): string | null {
	for (const line of lines) {
		const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
		if (m) return m[1] === m[2] ? m[2] : `${m[1]} -> ${m[2]}`;
	}
	for (const line of lines) {
		if (line.startsWith('+++ b/')) return line.slice('+++ b/'.length);
		if (line === '+++ /dev/null') return '/dev/null';
	}
	return null;
}
