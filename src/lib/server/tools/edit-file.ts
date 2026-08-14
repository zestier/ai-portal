import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createTwoFilesPatch, structuredPatch } from 'diff';
import type { Hunk } from 'diff';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { isGitRepo } from '../git';
import { isPathInWorkspace, resolveWithParentFallback } from '../permissions/workspace';
import { err, ok, type PortalTool } from './types';
import { resolveAbsoluteTarget } from './filesystem';
import {
	createTreeResolver,
	resolveWorktreeDir,
	WorktreeSelector,
	WORKTREE_WRITE_PARAM,
	type WorktreeToolContext
} from './worktree-selector';

export const MAX_EDIT_FILE_BYTES = 5_000_000;

// Maximum serialized size of the `edits` payload a single `multi_edit` call may
// carry. Mirrors the 1MB patch cap the portal's legacy unified-diff apply tool
// enforced, so an oversize batch is rejected up front rather than streaming
// megabytes through the permission layer.
export const MAX_MULTI_EDIT_PAYLOAD_BYTES = 1_000_000;

// Mirrors the SDK WriteInput so the aliased SDK `Write` tool (which sends
// `file_path`/`content` verbatim) parses cleanly. `file_path` is absolute per
// the SDK contract; the resolver below also accepts workspace-relative paths so
// tests (which pass relative paths) work unchanged.
const WriteArgs = z
	.object({
		file_path: z.string().min(1).max(4096),
		content: z.string().max(MAX_EDIT_FILE_BYTES),
		worktree: WorktreeSelector
	})
	.strict();

// Mirrors the SDK FileEditInput so the aliased SDK `Edit` tool (which sends
// `file_path`/`old_string`/`new_string`/`replace_all` verbatim) parses cleanly.
// `file_path` is absolute per the SDK contract; `resolveWriteTarget` below also
// accepts workspace-relative paths so tests (which pass relative paths) work unchanged.
const EditArgs = z
	.object({
		file_path: z.string().min(1).max(4096),
		old_string: z.string().min(1).max(MAX_EDIT_FILE_BYTES),
		new_string: z.string().max(MAX_EDIT_FILE_BYTES),
		replace_all: z.boolean().optional().default(false),
		worktree: WorktreeSelector
	})
	.strict();

// The portal's projection of the SDK FileWriteOutput contract (sdk-tools.d.ts),
// computed from pre/post content so the structured envelope matches what the
// SDK would emit for the same call.
export interface FileWriteStructuredPatch {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: string[];
}

export interface FileWriteGitDiff {
	filename: string;
	status: 'modified' | 'added';
	additions: number;
	deletions: number;
	changes: number;
	patch: string;
}

export interface FileWriteOutput {
	type: 'create' | 'update';
	filePath: string;
	content: string;
	structuredPatch: FileWriteStructuredPatch[];
	originalFile: string | null;
	gitDiff?: FileWriteGitDiff;
	userModified?: boolean;
}

// The portal's projection of the SDK FileEditOutput contract (sdk-tools.d.ts).
// `structuredPatch`/`gitDiff` reuse the FileWrite shapes — the SDK's
// FileEditOutput declares the identical field shapes.
export interface FileEditOutput {
	filePath: string;
	oldString: string;
	newString: string;
	originalFile: string | null;
	structuredPatch: FileWriteStructuredPatch[];
	userModified: boolean;
	replaceAll: boolean;
	gitDiff?: FileWriteGitDiff;
	// Present only when the edit matched via the numbered-read tab-eating
	// fallback. `ateLines` are the 1-based line numbers (into `old_string`)
	// whose stray leading numbering tab was dropped; `new_string` was written
	// with the same tabs removed, so the file carries no artifact.
	lenientTabEating?: { ateLines: number[] };
}

// Resolve a Write `file_path` to an absolute, symlink-resolved target inside
// the workspace. Accepts both the SDK contract's absolute paths and
// workspace-relative paths (as the tests use), rejecting any `..`
// escape that resolves outside the root. Exported so `multi_edit` resolves its
// `file_path`s through the exact same rules.
export function resolveWriteTarget(
	workspaceRoot: string,
	rawPath: string
): { ok: true; abs: string; rel: string } | { ok: false; message: string } {
	if (rawPath.includes('\0')) {
		return { ok: false, message: 'path must not contain NUL characters' };
	}
	const root = resolveWithParentFallback(resolve(workspaceRoot));
	if (root === null) {
		return { ok: false, message: 'could not resolve the workspace root' };
	}
	const abs = resolveWithParentFallback(
		isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath)
	);
	if (abs === null) {
		return { ok: false, message: `could not resolve path: ${rawPath}` };
	}
	if (!isPathInWorkspace(abs, root)) {
		return { ok: false, message: `path escapes the workspace: ${rawPath}` };
	}
	return { ok: true, abs, rel: abs === root ? '.' : relative(root, abs) };
}

// Read an existing file's content, enforcing the size/binary caps. Returns null
// when the path does not exist. Exported so `multi_edit` reads through the same
// gate (the batch must reject a >5MB or binary file exactly like `edit`).
export async function readExisting(abs: string): Promise<string | null> {
	const fileStat = await stat(abs).catch(() => null);
	if (fileStat === null) return null;
	if (!fileStat.isFile()) throw new Error('path is not a file');
	if (fileStat.size > MAX_EDIT_FILE_BYTES) {
		throw new Error(`file exceeds the ${MAX_EDIT_FILE_BYTES} byte edit limit`);
	}
	const content = await readFile(abs, 'utf8');
	if (content.includes('\0')) throw new Error('file contains null bytes and is likely binary');
	return content;
}

// The text a model sees for a FileWriteOutput, mirroring the SDK's rendering.
// The path is echoed verbatim from the call, matching the SDK (which renders
// the input path as given).
function writeConfirmation(type: 'create' | 'update', rawFilePath: string): string {
	return type === 'create'
		? `File created successfully at: ${rawFilePath} (file state is current in your context — no need to Read it back)`
		: `The file ${rawFilePath} has been updated successfully. (file state is current in your context — no need to Read it back)`;
}

// The text a model sees for a FileEditOutput, mirroring the SDK's rendering
// (`content` is confirmation only — the diff lives in the envelope's
// structuredPatch/gitDiff for the UI). `replace_all` swaps in the SDK's "all
// occurrences" wording. The path is echoed verbatim as given.
function editConfirmation(replaceAll: boolean, rawFilePath: string): string {
	return replaceAll
		? `The file ${rawFilePath} has been updated. All occurrences were successfully replaced. (file state is current in your context — no need to Read it back)`
		: `The file ${rawFilePath} has been updated successfully. (file state is current in your context — no need to Read it back)`;
}

// The SDK's Edit failure text for an unmatched `old_string`, byte-for-byte.
// The `<tool_use_error>` wrapper is part of the message, so the model sees
// exactly what the SDK built-in would emit. When a
// closest-match suggestion is found (Option 2), the `hint` appends a
// "Did you mean" line INSIDE the wrapper so the correction is part of the same
// model-facing error.
function editNotFoundError(oldString: string, hint?: string): string {
	return hint === undefined
		? `<tool_use_error>String to replace not found in file.\nString: ${oldString}</tool_use_error>`
		: `<tool_use_error>String to replace not found in file.\nString: ${oldString}\n${hint}</tool_use_error>`;
}

// jsdiff pads `---`/`+++` headers with a GNU-diff tab and prepends an
// `Index:`/`===` preamble; strip both so the patch is a clean unified diff the
// client DiffView parser accepts (mirrors diff-synth's cleanPatch).
function cleanTwoFilesPatch(patch: string): string {
	const lines = patch.split('\n');
	let i = 0;
	if (lines[i]?.startsWith('Index:')) i += 1;
	if (lines[i]?.startsWith('===')) i += 1;
	const rest = lines.slice(i);
	if (rest[0]?.startsWith('--- ')) rest[0] = rest[0].replace(/\s+$/, '');
	if (rest[1]?.startsWith('+++ ')) rest[1] = rest[1].replace(/\s+$/, '');
	return rest.join('\n');
}

// The SDK's `gitDiff` is the file's unified diff inside a git repo. The patch
// is synthesized from pre/post content via jsdiff (not `git diff`, so a
// freshly-created untracked file still yields a patch) with the SDK's
// status/additions/deletions/changes fields. Exported so `multi_edit` reports a
// per-edit gitDiff through the exact same projection as `edit`.
export function gitDiffFor(
	type: 'create' | 'update',
	filename: string,
	oldContent: string,
	newContent: string,
	hunks: Hunk[]
): FileWriteGitDiff {
	let additions = 0;
	let deletions = 0;
	for (const hunk of hunks) {
		for (const line of hunk.lines) {
			if (line.startsWith('+')) additions += 1;
			else if (line.startsWith('-')) deletions += 1;
		}
	}
	const oldName = type === 'create' ? '/dev/null' : `a/${filename}`;
	const patch = cleanTwoFilesPatch(
		createTwoFilesPatch(oldName, `b/${filename}`, oldContent, newContent, '', '', { context: 3 })
	);
	return {
		filename,
		status: type === 'create' ? 'added' : 'modified',
		additions,
		deletions,
		changes: additions + deletions,
		patch
	};
}

// The write itself plus the SDK FileWriteOutput projection and the model-facing
// confirmation text. `rawFilePath` is what the caller passed (absolute or
// relative) and is echoed verbatim in the confirmation, matching the SDK's
// rendering. `cwd` gates the gitDiff (only reported inside a git work tree).
async function performWrite(
	cwd: string,
	target: { abs: string; rel: string },
	rawFilePath: string,
	content: string
): Promise<{ result: FileWriteOutput; text: string } | { message: string }> {
	try {
		const existing = await readExisting(target.abs);
		const type: 'create' | 'update' = existing === null ? 'create' : 'update';
		await mkdir(dirname(target.abs), { recursive: true });
		// `wx` on create keeps the fail-if-someone-else-won-the-race guard from
		// the old create_file tool; updates overwrite deliberately (SDK Write).
		await writeFile(target.abs, content, {
			encoding: 'utf8',
			flag: existing === null ? 'wx' : 'w'
		});
		const oldContent = existing ?? '';
		const hunks = structuredPatch('a', 'b', oldContent, content, '', '', { context: 3 }).hunks;
		const result: FileWriteOutput = {
			type,
			filePath: target.abs,
			content,
			structuredPatch: hunks,
			originalFile: existing
		};
		if (await isGitRepo(cwd)) {
			result.gitDiff = gitDiffFor(type, target.rel, oldContent, content, hunks);
		}
		return { result, text: writeConfirmation(type, rawFilePath) };
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
			return { message: `file already exists: ${rawFilePath}` };
		}
		return { message: error instanceof Error ? error.message : String(error) };
	}
}

// ---- Numbered-read tab eating (Option 3) ----

// Number of leading `\t` characters on a line. Only tabs count: the numbering
// separator `read` emits is a tab, so a leading space never triggers eating.
export function leadingTabs(line: string): number {
	let n = 0;
	for (const ch of line) {
		if (ch !== '\t') break;
		n += 1;
	}
	return n;
}

// Decide whether `old_string` carries the per-line leading tab that numbered
// `read` output inserts between the line number and the content — `7\t\treturn;`
// renders line 7 whose content is `\treturn;`, and weak models copy that stray
// tab into `old_string`, so the exact match fails. Returns null when the string
// does not look like artifact-laden numbered output (the edit then falls
// through to the plain not-found path and its "Did you mean" suggestion);
// non-null means "drop exactly one leading tab on every line where `ate` is
// true".
//
// Coherent patterns only — a copied block's numbering tab is all-or-nothing:
//   - every line carries >= 1 leading tab (the whole block was copied), or
//   - the FIRST line carries none but every following non-empty line carries
//     one (the first line is a mid-line fragment of a file line, so it had no
//     numbering tab in the display and is matched as-is).
// Any other mix — e.g. a non-empty following line without a leading tab while
// its siblings have one — is refused (null): those tabs are real indentation,
// not numbering residue. Whitespace-only lines are exempt from the uniformity
// check: a blank file line renders as just `N\t`, which a model may copy as
// `\t` (eaten here) or drop wholesale (`""`), and both normalize identically.
// A trailing `\n` is a line terminator, not a content line: it never breaks
// uniformity and is never eaten.
export interface TabEatingPlan {
	// Per-line (0-based) whether exactly one leading tab should be dropped.
	ate: boolean[];
	// Per-line leading-tab count of the ORIGINAL `old_string`, which the
	// `new_string` mirror uses to recognize artifact-laden lines.
	oldTabs: number[];
	// `old_string` with `ate[i]` leading tabs removed per line.
	normalized: string;
}

export function planNumberingTabEating(oldString: string): TabEatingPlan | null {
	const lines = oldString.split('\n');
	const last = lines.length - 1;
	const hasTrailingNewline = lines.length > 1 && lines[last] === '';
	// Exclusive index of the body (content) lines — a trailing `\n` adds a final
	// empty element that is just the terminator.
	const bodyEnd = hasTrailingNewline ? last : lines.length;

	const ate: boolean[] = [];
	const oldTabs: number[] = [];
	for (let i = 0; i < lines.length; i += 1) {
		const tabs = leadingTabs(lines[i]!);
		oldTabs.push(tabs);
		const isTerminator = hasTrailingNewline && i === last;
		ate.push(!isTerminator && tabs > 0);
	}

	// Uniformity among following non-empty body lines (index >= 1): every one
	// must carry a leading tab, else the leading tabs are real indentation and
	// eating them would be guesswork.
	for (let i = 1; i < bodyEnd; i += 1) {
		const line = lines[i]!;
		if (line.trim().length > 0 && leadingTabs(line) === 0) return null;
	}

	// Nothing to eat anywhere — the fallback has nothing to do.
	if (!ate.some(Boolean)) return null;

	return {
		ate,
		oldTabs,
		normalized: lines.map((line, i) => (ate[i] ? line!.slice(1) : line)).join('\n')
	};
}

// Count occurrences of `needle` in `haystack`, including overlapping starts, so
// a uniqueness check can require exactly one match window.
function countOccurrences(haystack: string, needle: string): number {
	if (needle.length === 0) return 0;
	let count = 0;
	let idx = haystack.indexOf(needle);
	while (idx !== -1) {
		count += 1;
		idx = haystack.indexOf(needle, idx + 1);
	}
	return count;
}

// Apply the numbering-tab strip to `new_string` so the write does not reinsert
// the artifact (the extra indentation) the model copied from numbered output.
// The strip mirrors the old_string mask positionally, but only on lines that
// carry the artifact signature — a leading-tab count at least as large as the
// corresponding old_string line had. A freshly hand-typed `new_string` at the
// already-stripped depth has fewer tabs than the artifact-laden `old_string`
// and is left untouched. Lines beyond the old_string's count are fresh
// insertions and are never stripped.
export function mirrorNumberingTabEating(
	newString: string,
	ate: boolean[],
	oldTabs: number[]
): string {
	const lines = newString.split('\n');
	return lines
		.map((line, j) => {
			if (j >= ate.length) return line;
			if (!ate[j]) return line;
			if (leadingTabs(line) < oldTabs[j]!) return line;
			return line.slice(1);
		})
		.join('\n');
}

// The pure content transformation behind a replacement: exact-text first, then
// the numbered-read tab-eating fallback. Shared by the `edit` tool and
// `multi_edit` so the replace semantics (first occurrence unless `replaceAll`,
// no-change rejection, and the tab-eating fallback) cannot drift. `multi_edit`
// calls it against the in-memory batch content instead of a file, which is what
// makes the sequential intra-file semantics identical to repeated `edit` calls.
export type EditContentResult =
	| { ok: true; content: string; lenient?: { ateLines: number[] } }
	| { ok: false; reason: 'not_found' | 'no_change' };

export function applyEditToContent(
	content: string,
	oldString: string,
	newString: string,
	replaceAll: boolean
): EditContentResult {
	if (oldString === newString) return { ok: false, reason: 'no_change' };
	if (content.includes(oldString)) {
		return {
			ok: true,
			content: replaceAll
				? content.replaceAll(oldString, newString)
				: content.replace(oldString, newString)
		};
	}
	// Exact match failed. If `old_string` carries a stray leading tab from
	// numbered `read` output, match the tab-stripped form instead — but only
	// when that form is unambiguous (exactly one occurrence), so a wrong-line
	// edit is never silently applied. Mirror the strip onto `new_string` so the
	// artifact is not reinserted.
	const plan = planNumberingTabEating(oldString);
	if (plan !== null && countOccurrences(content, plan.normalized) === 1) {
		const mirrored = mirrorNumberingTabEating(newString, plan.ate, plan.oldTabs);
		const ateLines = plan.ate.map((ate, i) => (ate ? i + 1 : -1)).filter((line) => line > 0);
		return {
			ok: true,
			content: content.replace(plan.normalized, mirrored),
			lenient: { ateLines }
		};
	}
	return { ok: false, reason: 'not_found' };
}

// ---- "Did you mean" closest-match suggestion on not-found (Option 2) ----

// Minimum similarity (1 − distance/maxLen) a candidate window must reach to be
// surfaced as a suggestion. Below this the not-found error stays EXACTLY the
// SDK text, keeping existing tests byte-identical for low-similarity misses.
export const MIN_SUGGEST_SIMILARITY = 0.6;

// Maximum file lines a suggestion snippet may include before it is truncated
// (with an explicit '…' marker so a preview is never mistaken for the full
// string). The snippet is the matching window's exact bytes, JSON-escaped.
export const MAX_SUGGEST_LINES = 3;

// Absolute sanity cap on edit distance: a "closest match" must be within this
// many single-character edits of `old_string` regardless of string length. It is
// also the band width of the capped Levenshtein, so it bounds per-window scan
// cost — a region that differs in 25+ edits is not a near-miss worth surfacing
// even when the relative similarity clears the threshold.
export const MAX_SUGGEST_DISTANCE = 25;

// Skip the suggestion search entirely for files / old_strings above these sizes
// (the error then carries the plain SDK text, exactly as today). Length is
// measured in UTF-16 code units as a byte proxy (exact for ASCII text).
export const MAX_SUGGEST_FILE_BYTES = 512 * 1024;
export const MAX_SUGGEST_OLD_BYTES = 16 * 1024;

// Total snippet length cap (keeps the "Did you mean" line short).
const MAX_SUGGEST_SNIPPET_CHARS = 300;
export interface Suggestion {
	// The matching window's exact bytes as a complete JSON string literal
	// (surrounding quotes included), e.g.
	// `"export function main() {\n\tconst value = helper(\"value\");"` — copy
	// it verbatim as `old_string` to make the edit succeed. Truncation keeps the
	// closing quote and marks the cut with '…'.
	snippet: string;
	lineStart: number;
	lineEnd: number;
	similarity: number;
}

// Normalize a string for similarity scoring: collapse internal runs of
// spaces/tabs to a single space and convert CRLF to LF. Newlines are preserved
// (they anchor line structure), so a multi-line `old_string` scores against
// multi-line windows without losing alignment.
export function collapseWhitespace(s: string): string {
	return s.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ');
}

// Capped Levenshtein distance over code points: returns the true distance when
// it is <= maxDist, otherwise maxDist + 1 (a sentinel meaning "over the cap").
// The DP is banded to |i − j| <= maxDist — Levenshtein distance is always at
// least the length difference, so cells outside the band can never be <=
// maxDist — bounding per-call cost at O((m + n) · maxDist). maxDist is small
// (MIN_SUGGEST_DISTANCE at most), so this is deterministic and cheap. Exported
// so the unit tests can compare it against a reference DP.
export function cappedLevenshtein(
	a: readonly string[],
	b: readonly string[],
	maxDist: number
): number {
	if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
	const m = a.length;
	const n = b.length;
	let prev = new Array<number>(n + 1);
	for (let j = 0; j <= n; j++) prev[j] = j;
	for (let i = 1; i <= m; i++) {
		// Out-of-band cells are seeded to the sentinel so `prev[j] + 1` and
		// `cur[j - 1] + 1` never produce a false minimum.
		const cur = new Array<number>(n + 1).fill(maxDist + 1);
		cur[0] = i;
		const jLo = Math.max(1, i - maxDist);
		const jHi = Math.min(n, i + maxDist);
		for (let j = jLo; j <= jHi; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
		}
		prev = cur;
	}
	return Math.min(prev[n], maxDist + 1);
}

// Build the display snippet for a matching window: the window's exact bytes as
// a complete JSON string literal — surrounding quotes included — so the agent
// can copy it verbatim into `old_string` and the escapes carry the whitespace,
// character for character (`\n`/`\t`/`\r` and all). The raw window lines joined
// by '\n' reproduce the file's exact region (CRLF files keep their `\r` as-is).
// Truncation — line cap or char cap — keeps the closing quote and marks the cut
// with '…' so a preview is never mistaken for the full string.
function buildSnippet(window: readonly string[]): string {
	const lines = window.length > MAX_SUGGEST_LINES ? window.slice(0, MAX_SUGGEST_LINES) : window;
	const truncatedLines = lines.length < window.length;
	const raw = lines.join('\n') + (truncatedLines ? '\n…' : '');
	const literal = JSON.stringify(raw);
	if (literal.length <= MAX_SUGGEST_SNIPPET_CHARS) return literal;
	// Keep the opening quote, cut the escaped content, close the literal.
	const cut = literal.slice(0, MAX_SUGGEST_SNIPPET_CHARS);
	return `${cut.endsWith('\\') ? cut.slice(0, -1) : cut}…"`;
}

// Find the closest matching region of `content` for an unmatched `old_string`,
// so the not-found error can tell the model `Did you mean: "old_string": "<…>"`.
// Returns null when nothing clears the thresholds — the caller then emits the
// plain SDK error text (byte-identical to today).
export function findClosestMatch(content: string, oldString: string): Suggestion | null {
	if (content.length > MAX_SUGGEST_FILE_BYTES) return null;
	if (oldString.length > MAX_SUGGEST_OLD_BYTES) return null;
	const normOld = collapseWhitespace(oldString);
	if (normOld.length === 0) return null;
	const oldCodePoints = Array.from(normOld);

	// Candidate windows are runs of `oldStringLineCount` consecutive lines
	// (old_string's own line count preserves structure). No windows when the
	// file has fewer lines than old_string.
	const oldLineCount = oldString.split('\n').length;
	const fileLines = content.split('\n');
	if (fileLines.length < oldLineCount) return null;

	let best: Suggestion | null = null;
	for (let i = 0; i + oldLineCount <= fileLines.length; i++) {
		// The raw window is the file's exact bytes for this region (CRLF files
		// keep their trailing `\r`); the snippet JSON-escapes it verbatim so the
		// agent can pass it as `old_string`. Scoring uses a copy with the CRLF
		// residue stripped so CRLF files score equal to LF files.
		const rawWindow = fileLines.slice(i, i + oldLineCount);
		const window = rawWindow.map((line) => line.replace(/\r$/, ''));
		const candidate = collapseWhitespace(window.join('\n'));
		const candidateCodePoints = Array.from(candidate);
		const maxLen = Math.max(oldCodePoints.length, candidateCodePoints.length);
		if (maxLen === 0) continue;
		// similarity >= MIN_SUGGEST_SIMILARITY ⟺ distance <= maxLen · (1 − MIN).
		// The absolute sanity cap additionally rejects far-apart regions.
		const cap = Math.min(Math.floor(maxLen * (1 - MIN_SUGGEST_SIMILARITY)), MAX_SUGGEST_DISTANCE);
		const distance = cappedLevenshtein(oldCodePoints, candidateCodePoints, cap);
		if (distance > cap) continue;
		const similarity = Math.round((1 - distance / maxLen) * 1000) / 1000;
		if (best === null || similarity > best.similarity) {
			best = {
				snippet: buildSnippet(rawWindow),
				lineStart: i + 1,
				lineEnd: i + oldLineCount,
				similarity
			};
		}
	}
	return best;
}

// Render a suggestion as the model-facing hint. The snippet is already a
// complete JSON string literal of the window's exact bytes (quotes included,
// escape sequences visible), so the hint shows it as the `old_string` argument
// the agent should pass next — `"old_string": "<json>"` mirrors the tool call,
// character for character, with no invented indentation.
export function suggestionHint(suggestion: Suggestion): string {
	return `Did you mean: "old_string": ${suggestion.snippet}`;
}

// The edit itself plus the SDK FileEditOutput projection and the model-facing
// confirmation text. `rawFilePath` is echoed verbatim in the confirmation,
// matching the SDK's rendering (which echoes the input path as given).
// `cwd` gates the gitDiff (only reported inside a git work tree). Failures
// return the SDK-style message; the not-found case carries no `code`, so the
// model-facing text is exactly the SDK text — UNLESS a closest-match suggestion
// clears the threshold, in which case the message gains a "Did you mean" line
// and the envelope carries `code` + `details.suggestion` for the UI.
async function performEdit(
	cwd: string,
	target: { abs: string; rel: string },
	rawFilePath: string,
	oldString: string,
	newString: string,
	replaceAll: boolean
): Promise<
	| { result: FileEditOutput; text: string }
	| {
			message: string;
			code?: 'edit_failed';
			details?: { suggestion: Suggestion };
			detailsUiOnly?: boolean;
	  }
> {
	try {
		const existing = await readExisting(target.abs);
		if (existing === null) {
			// Edit is edit-only; a missing file has nothing to search, so it
			// fails like any unmatched string.
			return { message: editNotFoundError(oldString) };
		}
		const applied = applyEditToContent(existing, oldString, newString, replaceAll);
		if (!applied.ok) {
			if (applied.reason === 'not_found') {
				const suggestion = findClosestMatch(existing, oldString);
				if (suggestion === null) {
					// No window cleared the thresholds — exactly today's text.
					return { message: editNotFoundError(oldString) };
				}
				return {
					message: editNotFoundError(oldString, suggestionHint(suggestion)),
					code: 'edit_failed',
					details: { suggestion },
					// The message is the complete model-facing text; code/details
					// stay in the envelope for the UI only.
					detailsUiOnly: true
				};
			}
			return { message: 'new_string must be different from old_string' };
		}
		const content = applied.content;
		await writeFile(target.abs, content);
		const hunks = structuredPatch('a', 'b', existing, content, '', '', { context: 3 }).hunks;
		const result: FileEditOutput = {
			filePath: target.abs,
			oldString,
			newString,
			originalFile: existing,
			structuredPatch: hunks,
			userModified: false,
			replaceAll
		};
		if (applied.lenient !== undefined) result.lenientTabEating = applied.lenient;
		if (await isGitRepo(cwd)) {
			result.gitDiff = gitDiffFor('update', target.rel, existing, content, hunks);
		}
		return { result, text: editConfirmation(replaceAll, rawFilePath) };
	} catch (error) {
		return { message: error instanceof Error ? error.message : String(error), code: 'edit_failed' };
	}
}

export function buildEditFileTools(workspaceRoot: string, ctx?: WorktreeToolContext): PortalTool[] {
	const treeFor = createTreeResolver(workspaceRoot, ctx);
	return [
		{
			name: 'edit',
			description:
				"Replace exact text in an existing text file. `file_path` is absolute (workspace-relative also accepted) and must resolve inside the workspace; `old_string` is the literal text to find; `new_string` replaces it (must differ); `replace_all` (default false) replaces every occurrence instead of the first. Fails when old_string is not found, leaving the file unchanged — when `old_string` isn't found, the error may include the closest matching region ('Did you mean') to help correct the edit. A stray leading tab per line (as copied from numbered `read` output) is tolerated: it is ignored when matching `old_string` and stripped from `new_string` so no extra indentation is written. Pass worktree to edit a held worktree; use `.` or omit it for the local workspace. Prefer this exact-text form for a single replacement; use `multi_edit` for multi-hunk or multi-file edits (line-number edits are drift-prone — anchor on content, not line numbers).",
			argsSchema: EditArgs,
			parameters: {
				type: 'object',
				properties: {
					file_path: {
						type: 'string',
						description: 'Absolute path; must resolve inside the workspace.'
					},
					old_string: { type: 'string', description: 'Exact literal text to find and replace.' },
					new_string: { type: 'string', description: 'Replacement text.' },
					replace_all: {
						type: 'boolean',
						description:
							'Replace every occurrence of old_string instead of the first. Default false.'
					},
					worktree: WORKTREE_WRITE_PARAM
				},
				required: ['file_path', 'old_string', 'new_string'],
				additionalProperties: false
			},
			derivePermissionRequest(args) {
				const parsed = EditArgs.safeParse(args);
				if (!parsed.success) return null;
				const root = parsed.data.worktree
					? resolveWorktreeDir(parsed.data.worktree, ctx)
					: workspaceRoot;
				const path = root && resolveAbsoluteTarget(root, parsed.data.file_path);
				return path ? { permissionKind: 'edit', path } : null;
			},
			async handler(args) {
				const parsed = EditArgs.parse(args);
				const tree = treeFor(parsed.worktree);
				if (tree.error) return tree.error;
				const target = resolveWriteTarget(tree.cwd, parsed.file_path);
				if (!target.ok) return err(target.message, { code: 'invalid_path' });
				const outcome = await performEdit(
					tree.cwd,
					target,
					parsed.file_path,
					parsed.old_string,
					parsed.new_string,
					parsed.replace_all
				);
				if ('message' in outcome) {
					if (!outcome.code) return err(outcome.message);
					return err(outcome.message, {
						code: outcome.code,
						...(outcome.details !== undefined ? { details: outcome.details } : {}),
						...(outcome.detailsUiOnly !== undefined ? { detailsUiOnly: outcome.detailsUiOnly } : {})
					});
				}
				return ok(outcome.result, outcome.text, {
					views: [{ type: 'text', text: outcome.text }]
				});
			}
		},
		{
			name: 'write',
			description:
				'Write text content to a file, creating it or replacing an existing file. `file_path` is absolute (workspace-relative also accepted) and must resolve inside the workspace; `content` is the complete new text. Result reports created/updated plus a structured diff. Missing parent directories are created automatically. Pass worktree to write in a held worktree; use `.` or omit it for the local workspace.',
			argsSchema: WriteArgs,
			parameters: {
				type: 'object',
				properties: {
					file_path: {
						type: 'string',
						description: 'Absolute path; must resolve inside the workspace.'
					},
					content: { type: 'string', description: 'Complete text content to write.' },
					worktree: WORKTREE_WRITE_PARAM
				},
				required: ['file_path', 'content'],
				additionalProperties: false
			},
			derivePermissionRequest(args) {
				const parsed = WriteArgs.safeParse(args);
				if (!parsed.success) return null;
				const root = parsed.data.worktree
					? resolveWorktreeDir(parsed.data.worktree, ctx)
					: workspaceRoot;
				const path = root && resolveAbsoluteTarget(root, parsed.data.file_path);
				return path ? { permissionKind: 'write', path } : null;
			},
			async handler(args) {
				const parsed = WriteArgs.parse(args);
				const tree = treeFor(parsed.worktree);
				if (tree.error) return tree.error;
				const target = resolveWriteTarget(tree.cwd, parsed.file_path);
				if (!target.ok) return err(target.message, { code: 'invalid_path' });
				const outcome = await performWrite(tree.cwd, target, parsed.file_path, parsed.content);
				if ('message' in outcome) return err(outcome.message, { code: 'write_failed' });
				return ok(outcome.result, outcome.text, {
					views: [{ type: 'text', text: outcome.text }]
				});
			}
		}
	];
}
