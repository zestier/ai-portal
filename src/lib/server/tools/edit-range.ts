// Experiment (token-experiment branch, T38): a line-range edit with a checksum
// guard. The model navigates by line numbers (from `outline`), so it can edit a
// block without re-reading the whole file and without echoing the old block —
// it sends the block's header line as the `checksum`, the tool verifies it
// matches, replaces the range, and reports the diff plus how line numbers
// shifted. Pair with `outline` (get range + header text) and `read_delta` (see
// the change without a full re-read).
import { writeFile } from 'node:fs/promises';
import { structuredPatch } from 'diff';
import type { Hunk } from 'diff';
import { z } from 'zod';
import { isGitRepo } from '../git';
import { err, ok, type PortalTool, type ToolPermissionRequest } from './types';
import { resolveAbsoluteTarget } from './filesystem';
import {
	createTreeResolver,
	resolveWorktreeDir,
	WorktreeSelector,
	WORKTREE_WRITE_PARAM,
	type WorktreeToolContext
} from './worktree-selector';
import { resolveWriteTarget, readExisting, gitDiffFor, MAX_EDIT_FILE_BYTES } from './edit-file';
import type { FileWriteGitDiff } from './edit-file';

const EditRangeArgs = z
	.object({
		file_path: z.string().min(1).max(4096),
		start_line: z.number().int().min(1),
		end_line: z.number().int().min(1),
		// Expected content of `start_line` (the block's header line, as `outline`
		// shows it — trimmed on both sides). Guards against editing a stale range.
		checksum: z.string().min(1),
		new_text: z.string().max(MAX_EDIT_FILE_BYTES),
		worktree: WorktreeSelector
	})
	.strict();

export interface RangeEditResult {
	file_path: string;
	requested_range: { start: number; end: number };
	applied_range: { start: number; end: number };
	shift: { after: number; by: number };
	total_lines: number;
	old_lines: number;
	new_lines: number;
	hunks: Hunk[];
	gitDiff?: FileWriteGitDiff;
}

export type RangeEditOutcome =
	| { ok: true; content: string; result: RangeEditResult }
	| {
			ok: false;
			reason: 'out_of_range' | 'stale';
			message: string;
			details: unknown;
	  };

// Pure, exported for tests. Line numbers are 1-based inclusive, matching
// `read`/`outline`. The checksum is compared trimmed so the model can pass the
// trimmed header text `outline` showed.
export function applyRangeEdit(
	content: string,
	startLine: number,
	endLine: number,
	checksum: string,
	newText: string
): RangeEditOutcome {
	const nl = content.includes('\r\n') ? '\r\n' : '\n';
	const lines = content.split(/\r?\n/);
	const totalLines = lines.length;

	if (startLine < 1 || endLine < startLine || endLine > totalLines) {
		return {
			ok: false,
			reason: 'out_of_range',
			message: `range ${startLine}-${endLine} is out of bounds (file has ${totalLines} lines)`,
			details: { totalLines, max_end: Math.min(endLine, totalLines) }
		};
	}

	const current = lines[startLine - 1].trim();
	if (current !== checksum.trim()) {
		let matched: number | null = null;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].trim() === checksum.trim()) {
				matched = i + 1;
				break;
			}
		}
		const corrected =
			matched === null
				? null
				: { start: matched, end: Math.min(totalLines, matched + (endLine - startLine)) };
		return {
			ok: false,
			reason: 'stale',
			message: corrected
				? `stale range: line ${startLine} is '${current}', expected '${checksum.trim()}'. Checksum line found at line ${matched}; retry with start_line ${corrected.start}, end_line ${corrected.end}.`
				: `stale range: line ${startLine} is '${current}', expected '${checksum.trim()}'. Checksum line not found; re-outline the file for current line numbers.`,
			details: { current, matched_line: matched, corrected }
		};
	}

	const oldLines = endLine - startLine + 1;
	// Empty new_text deletes the range; split on the same line model as read.
	const newLinesArr = newText === '' ? [] : newText.split(/\r?\n/);
	lines.splice(startLine - 1, oldLines, ...newLinesArr);
	const content2 = lines.join(nl);
	const newLines = newLinesArr.length;
	return {
		ok: true,
		content: content2,
		result: {
			file_path: '',
			requested_range: { start: startLine, end: endLine },
			applied_range: { start: startLine, end: startLine + newLines - 1 },
			shift: { after: endLine, by: newLines - oldLines },
			total_lines: content2.split(/\r?\n/).length,
			old_lines: oldLines,
			new_lines: newLines,
			hunks: []
		}
	};
}

async function performRangeEdit(
	cwd: string,
	target: { abs: string; rel: string },
	rawFilePath: string,
	args: z.infer<typeof EditRangeArgs>
): Promise<
	{ result: RangeEditResult; text: string } | { message: string; code?: string; details?: unknown }
> {
	const existing = await readExisting(target.abs);
	if (existing === null) return { message: `File does not exist: ${rawFilePath}` };
	const out = applyRangeEdit(
		existing,
		args.start_line,
		args.end_line,
		args.checksum,
		args.new_text
	);
	if (!out.ok) return { message: out.message, code: out.reason, details: out.details };
	await writeFile(target.abs, out.content);
	const hunks = structuredPatch('a', 'b', existing, out.content, '', '', { context: 3 }).hunks;
	const result = { ...out.result, file_path: target.rel, hunks };
	const shift = result.shift;
	const delta = shift.by >= 0 ? `+${shift.by}` : String(shift.by);
	let text = `Edit applied: ${rawFilePath} lines ${result.applied_range.start}-${result.applied_range.end} (${result.old_lines} → ${result.new_lines} lines; lines after ${shift.after} shift by ${delta}). File now ${result.total_lines} lines.`;
	if (await isGitRepo(cwd)) {
		result.gitDiff = gitDiffFor('update', target.rel, existing, out.content, hunks);
		text += `\n${result.gitDiff.patch}`;
	}
	return { result, text };
}

export function buildEditRangeTools(
	workspaceRoot: string,
	ctx?: WorktreeToolContext
): PortalTool[] {
	const treeFor = createTreeResolver(workspaceRoot, ctx);
	return [
		{
			name: 'edit_range',
			description:
				'Replace a line range in a file, guarded by a checksum on the first line. Returns the diff and how line numbers shifted — no old-block echo, no post-edit re-read.',
			promptSnippet:
				'edit_range: replace a line range by line numbers + a header checksum; returns the diff and line shift.',
			promptGuidelines: [
				'Get the range and header text from `outline`; pass the header line as `checksum`. Use `read` only when you need a block body.',
				'On `stale` (checksum mismatch) the error gives the corrected line range — retry with it, no full re-read.',
				'`shift.after`/`shift.by` tell you how lines after the edit moved; re-outline before navigating to a saved line.'
			],
			argsSchema: EditRangeArgs,
			parameters: {
				type: 'object',
				properties: {
					file_path: {
						type: 'string',
						description: 'Absolute path; must resolve inside the workspace.'
					},
					start_line: {
						type: 'number',
						description: '1-indexed first line to replace (inclusive).'
					},
					end_line: { type: 'number', description: '1-indexed last line to replace (inclusive).' },
					checksum: {
						type: 'string',
						description:
							'Expected content of `start_line` (the block header line as `outline` shows it).'
					},
					new_text: { type: 'string', description: 'Replacement text for the range.' },
					worktree: WORKTREE_WRITE_PARAM
				},
				required: ['file_path', 'start_line', 'end_line', 'checksum', 'new_text'],
				additionalProperties: false
			},
			derivePermissionRequest(args): ToolPermissionRequest | null {
				const parsed = EditRangeArgs.safeParse(args);
				if (!parsed.success) return null;
				const root = parsed.data.worktree
					? resolveWorktreeDir(parsed.data.worktree, ctx)
					: workspaceRoot;
				const path = root && resolveAbsoluteTarget(root, parsed.data.file_path);
				return path ? { permissionKind: 'edit', path } : null;
			},
			async handler(args) {
				const parsed = EditRangeArgs.parse(args);
				const tree = treeFor(parsed.worktree);
				if (tree.error) return tree.error;
				const target = resolveWriteTarget(tree.cwd, parsed.file_path);
				if (!target.ok) return err(target.message, { code: 'invalid_path' });
				const outcome = await performRangeEdit(tree.cwd, target, parsed.file_path, parsed);
				if ('message' in outcome) {
					return err(outcome.message, {
						...(outcome.code !== undefined ? { code: outcome.code } : {}),
						...(outcome.details !== undefined ? { details: outcome.details } : {})
					});
				}
				return ok(outcome.result, 'Edit applied', {
					views: [{ type: 'text', text: outcome.text }]
				});
			}
		}
	];
}
