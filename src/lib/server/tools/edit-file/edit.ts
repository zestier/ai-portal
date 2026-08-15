import { writeFile } from 'node:fs/promises';
import { structuredPatch } from 'diff';
import { z } from 'zod';
import { isGitRepo } from '../../git';
import { err, ok, type PortalTool } from '../types';
import { resolveAbsoluteTarget } from '../filesystem';
import {
	createTreeResolver,
	resolveWorktreeDir,
	WorktreeSelector,
	WORKTREE_WRITE_PARAM,
	type WorktreeToolContext
} from '../worktree-selector';
import {
	applyEditToContent,
	editNotFoundError,
	findClosestMatch,
	gitDiffFor,
	MAX_EDIT_FILE_BYTES,
	readExisting,
	resolveWriteTarget,
	suggestionHint,
	type FileEditOutput
} from './common';

// Portal-native schema for the `edit` tool. The SDK's built-in tools are
// disabled (`noTools: 'builtin'`), so the field names are ours: `anchor` locates
// the edit by content, and optional `lines` extends it to a whole-line block
// (replace the anchor's line plus the following lines). No line numbers, no
// checksum — the content anchor self-verifies and survives line drift.
export const EditArgs = z
	.object({
		file_path: z.string().min(1).max(4096),
		anchor: z.string().min(1).max(MAX_EDIT_FILE_BYTES),
		lines: z.number().int().min(1).optional(),
		new_string: z.string().max(MAX_EDIT_FILE_BYTES),
		replace_all: z.boolean().optional().default(false),
		worktree: WorktreeSelector
	})
	.strict();

// The text a model sees for a FileEditOutput, mirroring the SDK's rendering
// (`content` is confirmation only — the diff lives in the envelope's
// structuredPatch/gitDiff for the UI). `replace_all` swaps in the SDK's "all
// occurrences" wording. The path is echoed verbatim as given.
function editConfirmation(replaceAll: boolean, rawFilePath: string): string {
	return replaceAll
		? `The file ${rawFilePath} has been updated. All occurrences were successfully replaced. (file state is current in your context — no need to Read it back)`
		: `The file ${rawFilePath} has been updated successfully. (file state is current in your context — no need to Read it back)`;
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
	args: z.infer<typeof EditArgs>
): Promise<
	| { result: FileEditOutput; text: string }
	| {
			message: string;
			code?: string;
			details?: unknown;
			detailsUiOnly?: boolean;
	  }
> {
	const { anchor, new_string: newString, replace_all: replaceAll, lines } = args;
	try {
		const existing = await readExisting(target.abs);
		if (existing === null) {
			// Edit is edit-only; a missing file has nothing to search, so it
			// fails like any unmatched string.
			return { message: editNotFoundError(anchor) };
		}
		const applied = applyEditToContent(existing, anchor, newString, replaceAll, lines);
		if (!applied.ok) {
			if (applied.reason === 'not_found') {
				const suggestion = findClosestMatch(existing, anchor);
				if (suggestion === null) {
					// No window cleared the thresholds — exactly today's text.
					return { message: editNotFoundError(anchor) };
				}
				return {
					message: editNotFoundError(anchor, suggestionHint(suggestion)),
					code: 'edit_failed',
					details: { suggestion },
					// The message is the complete model-facing text; code/details
					// stay in the envelope for the UI only.
					detailsUiOnly: true
				};
			}
			return { message: 'new_string must be different from anchor' };
		}
		const content = applied.content;
		await writeFile(target.abs, content);
		const hunks = structuredPatch('a', 'b', existing, content, '', '', { context: 3 }).hunks;
		const result: FileEditOutput = {
			filePath: target.abs,
			oldString: anchor,
			newString,
			originalFile: existing,
			structuredPatch: hunks,
			userModified: false,
			replaceAll
		};
		if (applied.lenient !== undefined) result.lenientTabEating = applied.lenient;
		if (applied.shift !== undefined && applied.replacedLines !== undefined) {
			result.replacedLines = applied.replacedLines;
			result.shift = applied.shift;
		}
		if (await isGitRepo(cwd)) {
			result.gitDiff = gitDiffFor('update', target.rel, existing, content, hunks);
		}
		const shiftText =
			applied.shift === undefined
				? ''
				: ` Lines after ${applied.shift.after} shift by ${applied.shift.by >= 0 ? '+' : ''}${applied.shift.by}.`;
		return { result, text: editConfirmation(replaceAll, rawFilePath) + shiftText };
	} catch (error) {
		return { message: error instanceof Error ? error.message : String(error), code: 'edit_failed' };
	}
}

export function buildEditTool(workspaceRoot: string, ctx?: WorktreeToolContext): PortalTool {
	const treeFor = createTreeResolver(workspaceRoot, ctx);
	return {
		name: 'edit',
		description: 'Replace exact text in an existing workspace file.',
		promptGuidelines: [
			"Fails (leaving the file unchanged) when the `anchor` is not found — the error may include the closest matching region ('Did you mean') to help correct the edit.",
			"`anchor` locates the edit (content, not line numbers). Omit `lines` to replace just the anchor text; pass `lines` (total lines counting from the anchor) to replace a whole block — use the block header + size from read's outline. Returns the diff and how lines after the block shifted. Use `multi_edit` for multi-hunk or multi-file edits.",
			'Pass whole lines as the anchor when using `lines` (the leading indentation of the anchor line is part of the replaced block).'
		],
		argsSchema: EditArgs,
		parameters: {
			type: 'object',
			properties: {
				file_path: {
					type: 'string',
					description: 'Absolute path; must resolve inside the workspace.'
				},
				anchor: {
					type: 'string',
					description:
						'Text locating the edit — usually the first line of the block to replace (whole lines work best with `lines`).'
				},
				lines: {
					type: 'number',
					description:
						"Total lines to replace, counting from the anchor line. Omit to replace just the anchor text. Use the block header + size from read's outline."
				},
				new_string: {
					type: 'string',
					description: 'Replacement text.'
				},
				replace_all: {
					type: 'boolean',
					description: 'Replace every occurrence of the anchor. Default false.'
				},
				worktree: WORKTREE_WRITE_PARAM
			},
			required: ['file_path', 'anchor', 'new_string'],
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
			const outcome = await performEdit(tree.cwd, target, parsed.file_path, parsed);
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
	};
}
