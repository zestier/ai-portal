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
// tests and golden replays (which pass relative paths) work unchanged.
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
// accepts workspace-relative paths so tests and golden replays work unchanged.
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
}

// Resolve a Write `file_path` to an absolute, symlink-resolved target inside
// the workspace. Accepts both the SDK contract's absolute paths and
// workspace-relative paths (as the golden capture used), rejecting any `..`
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

// The text a model sees for a FileWriteOutput, mirroring the SDK's rendering so
// the golden conformance suite can compare byte-for-byte. The path is echoed
// verbatim from the call, matching the SDK (which renders the input path as
// given).
function writeConfirmation(type: 'create' | 'update', rawFilePath: string): string {
	return type === 'create'
		? `File created successfully at: ${rawFilePath} (file state is current in your context — no need to Read it back)`
		: `The file ${rawFilePath} has been updated successfully. (file state is current in your context — no need to Read it back)`;
}

// The text a model sees for a FileEditOutput, mirroring the SDK's rendering
// (the golden capture's `content` is confirmation only — the diff lives in the
// envelope's structuredPatch/gitDiff for the UI). `replace_all` swaps in the
// SDK's "all occurrences" wording. The path is echoed verbatim as given.
function editConfirmation(replaceAll: boolean, rawFilePath: string): string {
	return replaceAll
		? `The file ${rawFilePath} has been updated. All occurrences were successfully replaced. (file state is current in your context — no need to Read it back)`
		: `The file ${rawFilePath} has been updated successfully. (file state is current in your context — no need to Read it back)`;
}

// The SDK's Edit failure text for an unmatched `old_string`, byte-for-byte
// (golden Edit/not_found). The `<tool_use_error>` wrapper is part of the
// message, so the model sees exactly what the SDK built-in would emit. When a
// closest-match suggestion is found (Option 2), the `hint` appends a
// "Did you mean" line INSIDE the wrapper so the correction is part of the same
// model-facing error.
function editNotFoundError(oldString: string, hint?: string): string {
	return hint === undefined
		? `<tool_use_error>String to replace not found in file.\nString: ${oldString}</tool_use_error>`
		: `<tool_use_error>String to replace not found in file.\nString: ${oldString}\nDid you mean: ${hint}</tool_use_error>`;
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

// Run a Write call against a plain workspace directory and render its model
// text (used by the golden conformance registry; the tool handler reuses
// `performWrite` so the two cannot drift).
export async function renderWriteModelText(
	args: Record<string, unknown>,
	cwd: string
): Promise<string> {
	const parsed = WriteArgs.parse(args);
	const target = resolveWriteTarget(cwd, parsed.file_path);
	if (!target.ok) throw new Error(target.message);
	const outcome = await performWrite(cwd, target, parsed.file_path, parsed.content);
	if ('message' in outcome) throw new Error(outcome.message);
	return outcome.text;
}

// The pure content transformation behind an exact-text replacement. Shared by
// the `edit` tool and `multi_edit` so the replace semantics (first occurrence
// unless `replaceAll`, no-change rejection) cannot drift. `multi_edit` calls it
// against the in-memory batch content instead of a file, which is what makes the
// sequential intra-file semantics identical to repeated `edit` calls.
export type EditContentResult =
	| { ok: true; content: string }
	| { ok: false; reason: 'not_found' | 'no_change' };

export function applyEditToContent(
	content: string,
	oldString: string,
	newString: string,
	replaceAll: boolean
): EditContentResult {
	if (oldString === newString) return { ok: false, reason: 'no_change' };
	if (!content.includes(oldString)) return { ok: false, reason: 'not_found' };
	return {
		ok: true,
		content: replaceAll
			? content.replaceAll(oldString, newString)
			: content.replace(oldString, newString)
	};
}

// ---- "Did you mean" closest-match suggestion on not-found (Option 2) ----

// Minimum similarity (1 − distance/maxLen) a candidate window must reach to be
// surfaced as a suggestion. Below this the not-found error stays EXACTLY the
// SDK text, which keeps the SDK-parity goldens and existing tests
// byte-identical for low-similarity misses (e.g. the golden `does not exist
// anywhere` vs the fixture's greek-letter lines).
export const MIN_SUGGEST_SIMILARITY = 0.6;

// Maximum trimmed lines shown in a suggestion snippet (the hint stays small).
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

// Build the display snippet for a matching window: at most MAX_SUGGEST_LINES
// trimmed lines (the file's actual text, not the normalized form), with the
// total length capped so the hint stays small.
function buildSnippet(window: readonly string[]): string {
	const lines = window.map((line) => line.trim()).slice(0, MAX_SUGGEST_LINES);
	const out: string[] = [];
	let budget = MAX_SUGGEST_SNIPPET_CHARS;
	for (const line of lines) {
		if (line.length > budget) {
			out.push(`${line.slice(0, budget)}…`);
			break;
		}
		out.push(line);
		budget -= line.length;
	}
	return out.join('\n');
}

// Find the closest matching region of `content` for an unmatched `old_string`,
// so the not-found error can tell the model "Did you mean: <this>".
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
		// Strip the CRLF residue (`\r` before a `\n`) so CRLF files score equal
		// to LF files; `collapseWhitespace` then has no stray `\r` to account for.
		const window = fileLines.slice(i, i + oldLineCount).map((line) => line.replace(/\r$/, ''));
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
				snippet: buildSnippet(window),
				lineStart: i + 1,
				lineEnd: i + oldLineCount,
				similarity
			};
		}
	}
	return best;
}

// Render a suggestion as the model-facing "Did you mean" hint: the line range
// (1-based) plus the snippet. Single-line windows read "line N", multi-line
// windows "lines N-M", e.g. `line 3: gamma three`.
export function suggestionHint(suggestion: Suggestion): string {
	const range =
		suggestion.lineStart === suggestion.lineEnd
			? `line ${suggestion.lineStart}`
			: `lines ${suggestion.lineStart}-${suggestion.lineEnd}`;
	return `${range}: ${suggestion.snippet}`;
}

// The edit itself plus the SDK FileEditOutput projection and the model-facing
// confirmation text. `rawFilePath` is echoed verbatim in the confirmation,
// matching the SDK's rendering (the golden capture passed relative paths).
// `cwd` gates the gitDiff (only reported inside a git work tree). Failures
// return the SDK-style message; the not-found case carries no `code` so the
// model-facing text stays byte-identical to the golden capture — UNLESS a
// closest-match suggestion clears the threshold, in which case the message gains
// a "Did you mean" line and the envelope carries `code` + `details.suggestion`
// for the UI.
async function performEdit(
	cwd: string,
	target: { abs: string; rel: string },
	rawFilePath: string,
	oldString: string,
	newString: string,
	replaceAll: boolean
): Promise<
	| { result: FileEditOutput; text: string }
	| { message: string; code?: 'edit_failed'; details?: { suggestion: Suggestion } }
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
					details: { suggestion }
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
		if (await isGitRepo(cwd)) {
			result.gitDiff = gitDiffFor('update', target.rel, existing, content, hunks);
		}
		return { result, text: editConfirmation(replaceAll, rawFilePath) };
	} catch (error) {
		return { message: error instanceof Error ? error.message : String(error), code: 'edit_failed' };
	}
}

// Run an Edit call against a plain workspace directory and render its model
// text (used by the golden conformance registry; the tool handler reuses
// `performEdit` so the two cannot drift). Failures return the SDK-style message
// rather than throwing so the captured error goldens compare equal.
export async function renderEditModelText(
	args: Record<string, unknown>,
	cwd: string
): Promise<string> {
	const parsed = EditArgs.parse(args);
	const target = resolveWriteTarget(cwd, parsed.file_path);
	if (!target.ok) throw new Error(target.message);
	const outcome = await performEdit(
		cwd,
		target,
		parsed.file_path,
		parsed.old_string,
		parsed.new_string,
		parsed.replace_all
	);
	if ('message' in outcome) return outcome.message;
	return outcome.text;
}

export function buildEditFileTools(workspaceRoot: string, ctx?: WorktreeToolContext): PortalTool[] {
	const treeFor = createTreeResolver(workspaceRoot, ctx);
	return [
		{
			name: 'edit',
			description:
				"Replace exact text in an existing text file. `file_path` is absolute (workspace-relative also accepted) and must resolve inside the workspace; `old_string` is the literal text to find; `new_string` replaces it (must differ); `replace_all` (default false) replaces every occurrence instead of the first. Fails when old_string is not found, leaving the file unchanged — when `old_string` isn't found, the error may include the closest matching region ('Did you mean') to help correct the edit. Pass worktree to edit a held worktree; use `.` or omit it for the local workspace. Prefer this exact-text form for a single replacement; use `multi_edit` for multi-hunk or multi-file edits (line-number edits are drift-prone — anchor on content, not line numbers).",
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
					return err(
						outcome.message,
						outcome.code ? { code: outcome.code, details: outcome.details } : undefined
					);
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
