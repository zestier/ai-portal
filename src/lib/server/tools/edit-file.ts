import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createTwoFilesPatch, structuredPatch } from 'diff';
import type { Hunk } from 'diff';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { isGitRepo } from '../git';
import { isPathInWorkspace, resolveWithParentFallback } from '../permissions/workspace';
import { err, ok, type PortalTool, type ToolPermissionRequest } from './types';
import { resolveAbsoluteTarget, resolveWorkspaceTarget } from './filesystem';
import {
	createTreeResolver,
	resolveWorktreeDir,
	WorktreeSelector,
	WORKTREE_WRITE_PARAM,
	type WorktreeToolContext
} from './worktree-selector';

const MAX_EDIT_FILE_BYTES = 5_000_000;
const MAX_REPLACEMENTS = 1_000;

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

const ReplaceLinesArgs = z
	.object({
		path: z.string().min(1).max(4096),
		startLine: z.number().int().min(1),
		endLine: z.number().int().min(1),
		content: z.string().max(MAX_EDIT_FILE_BYTES),
		worktree: WorktreeSelector
	})
	.strict();

const ReplaceTextArgs = z
	.object({
		path: z.string().min(1).max(4096),
		oldText: z.string().min(1).max(MAX_EDIT_FILE_BYTES),
		newText: z.string().max(MAX_EDIT_FILE_BYTES),
		startLine: z.number().int().min(1).optional(),
		endLine: z.number().int().min(1).optional(),
		maxReplacements: z.number().int().min(1).max(MAX_REPLACEMENTS).optional().default(1),
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

function lineEnding(content: string): '\r\n' | '\n' {
	return content.includes('\r\n') ? '\r\n' : '\n';
}

function lineCount(content: string): number {
	if (content.length === 0) return 0;
	const lines = content.split(/\r?\n/);
	return content.endsWith('\n') ? lines.length - 1 : lines.length;
}

function lineOffsets(content: string, startLine: number, endLine: number): [number, number] | null {
	const count = lineCount(content);
	if (startLine > endLine || endLine > count) return null;
	let start = 0;
	for (let line = 1; line < startLine; line += 1) {
		start = content.indexOf('\n', start) + 1;
	}
	let end = start;
	for (let line = startLine; line <= endLine; line += 1) {
		const newline = content.indexOf('\n', end);
		if (newline === -1) return [start, content.length];
		end = newline + 1;
	}
	return [start, end];
}

async function readEditableFile(path: string): Promise<string> {
	const fileStat = await stat(path);
	if (!fileStat.isFile()) throw new Error('path is not a file');
	if (fileStat.size > MAX_EDIT_FILE_BYTES) {
		throw new Error(`file exceeds the ${MAX_EDIT_FILE_BYTES} byte edit limit`);
	}
	const content = await readFile(path, 'utf8');
	if (content.includes('\0')) throw new Error('file contains null bytes and is likely binary');
	return content;
}

function permissionRequest(
	workspaceRoot: string,
	ctx: WorktreeToolContext | undefined,
	args: unknown,
	schema: typeof ReplaceLinesArgs | typeof ReplaceTextArgs
): ToolPermissionRequest | null {
	const parsed = schema.safeParse(args);
	if (!parsed.success) return null;
	const root = parsed.data.worktree ? resolveWorktreeDir(parsed.data.worktree, ctx) : workspaceRoot;
	const path = root && resolveAbsoluteTarget(root, parsed.data.path);
	return path ? { permissionKind: 'write', path } : null;
}

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
// escape that resolves outside the root.
function resolveWriteTarget(
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

async function readExisting(abs: string): Promise<string | null> {
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
// status/additions/deletions/changes fields.
function gitDiffFor(
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
		if (oldString === newString) {
			return { message: 'new_string must be different from old_string' };
		}
		if (!existing.includes(oldString)) {
			return { message: editNotFoundError(oldString) };
		}
		const content = replaceAll
			? existing.replaceAll(oldString, newString)
			: existing.replace(oldString, newString);
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
				'Replace exact text in an existing text file, mirroring the SDK Edit contract: `file_path` is absolute (workspace-relative paths are also accepted) and must resolve inside the workspace, `old_string` is the literal text to find, `new_string` replaces it (must differ from old_string), and `replace_all` (default false) replaces every occurrence instead of the first. Fails when old_string is not found, leaving the file unchanged. Pass worktree to edit a held worktree; use `.` or omit it for the local workspace.',
			argsSchema: EditArgs,
			parameters: {
				type: 'object',
				properties: {
					file_path: {
						type: 'string',
						description:
							'Absolute path of the existing file to edit; must resolve inside the workspace.'
					},
					old_string: { type: 'string', description: 'Exact literal text to find and replace.' },
					new_string: { type: 'string', description: 'Replacement text.' },
					replace_all: {
						type: 'boolean',
						description:
							'Replace all occurrences of old_string instead of just the first. Defaults to false.'
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
				'Write text content to a file, creating it or replacing an existing file. Mirrors the SDK Write contract: `file_path` is absolute (workspace-relative paths are also accepted) and must resolve inside the workspace, `content` is the complete new text, and the result reports whether the file was created or updated along with a structured diff. Missing parent directories are created automatically. Pass worktree to write in a held worktree; use `.` or omit it for the local workspace.',
			argsSchema: WriteArgs,
			parameters: {
				type: 'object',
				properties: {
					file_path: {
						type: 'string',
						description: 'Absolute path of the file to write; must resolve inside the workspace.'
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
		},
		{
			name: 'replace_lines',
			description:
				'Replace an inclusive 1-indexed range of existing lines in a text file. Use empty content to delete the range. The file must already exist, the full range must be valid, and line endings are preserved. Pass worktree to edit a held worktree; use `.` or omit it for the local workspace.',
			argsSchema: ReplaceLinesArgs,
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Workspace-relative path of the existing file.' },
					startLine: { type: 'number', description: 'First line to replace, 1-indexed.' },
					endLine: { type: 'number', description: 'Last line to replace, inclusive.' },
					content: { type: 'string', description: 'Replacement text. Empty deletes the range.' },
					worktree: WORKTREE_WRITE_PARAM
				},
				required: ['path', 'startLine', 'endLine', 'content'],
				additionalProperties: false
			},
			derivePermissionRequest(args) {
				return permissionRequest(workspaceRoot, ctx, args, ReplaceLinesArgs);
			},
			async handler(args) {
				const parsed = ReplaceLinesArgs.parse(args);
				const tree = treeFor(parsed.worktree);
				if (tree.error) return tree.error;
				const target = resolveWorkspaceTarget(tree.cwd, parsed.path);
				if (!target.ok) return err(target.message, { code: 'invalid_path' });
				try {
					const source = await readEditableFile(target.abs);
					const offsets = lineOffsets(source, parsed.startLine, parsed.endLine);
					if (!offsets) {
						return err(
							`line range ${parsed.startLine}-${parsed.endLine} is invalid for a ${lineCount(source)} line file`,
							{ code: 'invalid_line_range' }
						);
					}
					const ending = lineEnding(source);
					let replacement = parsed.content.replace(/\r?\n/g, ending);
					if (replacement && offsets[1] < source.length && !replacement.endsWith(ending)) {
						replacement += ending;
					}
					const content = source.slice(0, offsets[0]) + replacement + source.slice(offsets[1]);
					await writeFile(target.abs, content);
					return ok(
						{ path: target.rel, startLine: parsed.startLine, endLine: parsed.endLine },
						`Replaced lines ${parsed.startLine}-${parsed.endLine} in ${target.rel}.`
					);
				} catch (error) {
					return err(error instanceof Error ? error.message : String(error), {
						code: 'edit_failed'
					});
				}
			}
		},
		{
			name: 'replace_text',
			description:
				'Replace exact text in an existing text file. Optionally limit matching to an inclusive 1-indexed line range and cap replacements with maxReplacements (default 1). Fails when no exact match exists. This is literal text matching, not a regular expression. Pass worktree to edit a held worktree; use `.` or omit it for the local workspace.',
			argsSchema: ReplaceTextArgs,
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Workspace-relative path of the existing file.' },
					oldText: { type: 'string', description: 'Exact literal text to find.' },
					newText: { type: 'string', description: 'Replacement text.' },
					startLine: { type: 'number', description: 'Optional first line to search, 1-indexed.' },
					endLine: { type: 'number', description: 'Optional last line to search, inclusive.' },
					maxReplacements: {
						type: 'number',
						description: 'Maximum matches to replace. Defaults to 1.'
					},
					worktree: WORKTREE_WRITE_PARAM
				},
				required: ['path', 'oldText', 'newText'],
				additionalProperties: false
			},
			derivePermissionRequest(args) {
				return permissionRequest(workspaceRoot, ctx, args, ReplaceTextArgs);
			},
			async handler(args) {
				const parsed = ReplaceTextArgs.parse(args);
				if (
					parsed.startLine !== undefined &&
					parsed.endLine !== undefined &&
					parsed.startLine > parsed.endLine
				) {
					return err('startLine must be less than or equal to endLine', {
						code: 'invalid_line_range'
					});
				}
				const tree = treeFor(parsed.worktree);
				if (tree.error) return tree.error;
				const target = resolveWorkspaceTarget(tree.cwd, parsed.path);
				if (!target.ok) return err(target.message, { code: 'invalid_path' });
				try {
					const source = await readEditableFile(target.abs);
					const startLine = parsed.startLine ?? 1;
					const endLine = parsed.endLine ?? lineCount(source);
					const offsets = lineOffsets(source, startLine, endLine);
					if (!offsets) {
						return err(
							`line range ${startLine}-${endLine} is invalid for a ${lineCount(source)} line file`,
							{ code: 'invalid_line_range' }
						);
					}
					const selection = source.slice(offsets[0], offsets[1]);
					let cursor = 0;
					let replacements = 0;
					let replaced = '';
					while (replacements < parsed.maxReplacements) {
						const index = selection.indexOf(parsed.oldText, cursor);
						if (index === -1) break;
						replaced += selection.slice(cursor, index) + parsed.newText;
						cursor = index + parsed.oldText.length;
						replacements += 1;
					}
					if (replacements === 0) {
						return err('oldText was not found in the selected range', { code: 'text_not_found' });
					}
					replaced += selection.slice(cursor);
					const content = source.slice(0, offsets[0]) + replaced + source.slice(offsets[1]);
					await writeFile(target.abs, content);
					return ok(
						{ path: target.rel, replacements },
						`Replaced ${replacements} occurrence(s) in ${target.rel}.`
					);
				} catch (error) {
					return err(error instanceof Error ? error.message : String(error), {
						code: 'edit_failed'
					});
				}
			}
		}
	];
}
