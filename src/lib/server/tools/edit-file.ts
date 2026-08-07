import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
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

const CreateFileArgs = z
	.object({
		path: z.string().min(1).max(4096),
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
	schema: typeof CreateFileArgs | typeof ReplaceLinesArgs | typeof ReplaceTextArgs
): ToolPermissionRequest | null {
	const parsed = schema.safeParse(args);
	if (!parsed.success) return null;
	const root = parsed.data.worktree ? resolveWorktreeDir(parsed.data.worktree, ctx) : workspaceRoot;
	const path = root && resolveAbsoluteTarget(root, parsed.data.path);
	return path ? { permissionKind: 'write', path } : null;
}

export function buildEditFileTools(workspaceRoot: string, ctx?: WorktreeToolContext): PortalTool[] {
	const treeFor = createTreeResolver(workspaceRoot, ctx);
	return [
		{
			name: 'create_file',
			description:
				'Create a new text file with the provided content. Missing parent directories are created automatically. Fails rather than overwriting if the path already exists. The path must be workspace-relative. Pass worktree to create in a held worktree; use `.` or omit it for the local workspace.',
			argsSchema: CreateFileArgs,
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Workspace-relative path of the new file.' },
					content: { type: 'string', description: 'Complete initial text content.' },
					worktree: WORKTREE_WRITE_PARAM
				},
				required: ['path', 'content'],
				additionalProperties: false
			},
			derivePermissionRequest(args) {
				return permissionRequest(workspaceRoot, ctx, args, CreateFileArgs);
			},
			async handler(args) {
				const parsed = CreateFileArgs.parse(args);
				const tree = treeFor(parsed.worktree);
				if (tree.error) return tree.error;
				const target = resolveWorkspaceTarget(tree.cwd, parsed.path);
				if (!target.ok) return err(target.message, { code: 'invalid_path' });
				try {
					await mkdir(dirname(target.abs), { recursive: true });
					await writeFile(target.abs, parsed.content, { encoding: 'utf8', flag: 'wx' });
					return ok(
						{ path: target.rel, size: Buffer.byteLength(parsed.content) },
						`Created file: ${target.rel}`
					);
				} catch (error) {
					if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
						return err(`file already exists: ${target.rel}`, { code: 'file_exists' });
					}
					return err(error instanceof Error ? error.message : String(error), {
						code: 'create_failed'
					});
				}
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
