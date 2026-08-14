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
// message, so the model sees exactly what the SDK built-in would emit.
function editNotFoundError(oldString: string): string {
	return `<tool_use_error>String to replace not found in file.\nString: ${oldString}</tool_use_error>`;
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

// The edit itself plus the SDK FileEditOutput projection and the model-facing
// confirmation text. `rawFilePath` is echoed verbatim in the confirmation,
// matching the SDK's rendering (the golden capture passed relative paths).
// `cwd` gates the gitDiff (only reported inside a git work tree). Failures
// return the SDK-style message; the not-found case carries no `code` so the
// model-facing text stays byte-identical to the golden capture.
async function performEdit(
	cwd: string,
	target: { abs: string; rel: string },
	rawFilePath: string,
	oldString: string,
	newString: string,
	replaceAll: boolean
): Promise<{ result: FileEditOutput; text: string } | { message: string; code?: 'edit_failed' }> {
	try {
		const existing = await readExisting(target.abs);
		if (existing === null) {
			// Edit is edit-only; a missing file has nothing to search, so it
			// fails like any unmatched string.
			return { message: editNotFoundError(oldString) };
		}
		const applied = applyEditToContent(existing, oldString, newString, replaceAll);
		if (!applied.ok) {
			return applied.reason === 'not_found'
				? { message: editNotFoundError(oldString) }
				: { message: 'new_string must be different from old_string' };
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
				'Replace exact text in an existing text file. `file_path` is absolute (workspace-relative also accepted) and must resolve inside the workspace; `old_string` is the literal text to find; `new_string` replaces it (must differ); `replace_all` (default false) replaces every occurrence instead of the first. Fails when old_string is not found, leaving the file unchanged. Pass worktree to edit a held worktree; use `.` or omit it for the local workspace. Prefer this exact-text form for a single replacement; use `multi_edit` for multi-hunk or multi-file edits (line-number edits are drift-prone — anchor on content, not line numbers).',
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
					return err(outcome.message, outcome.code ? { code: outcome.code } : undefined);
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
