import { writeFile } from "node:fs/promises";
import { structuredPatch } from "diff";
import { z } from "zod";
import { isGitRepo } from "../../git";
import { err, ok, type PortalTool } from "../types";
import { resolveAbsoluteTarget } from "../filesystem";
import {
  createTreeResolver,
  resolveWorktreeDir,
  WorktreeSelector,
  WORKTREE_WRITE_PARAM,
  type WorktreeToolContext,
} from "../worktree-selector";
import {
  applyEditToContent,
  editNotFoundError,
  findClosestMatch,
  gitDiffFor,
  MAX_EDIT_FILE_BYTES,
  readExisting,
  resolveWriteTarget,
  suggestionHint,
  type FileEditOutput,
} from "./common";

// Portal-native schema for the `edit` tool. The SDK's built-in tools are
// disabled (`noTools: 'builtin'`), so the field names are ours: `old_string`
// locates the edit by exact content, mirroring `multi_edit`'s `old_string`.
// No line numbers, no checksum — the content self-verifies and survives line
// drift.
export const EditArgs = z
  .object({
    file_path: z.string().min(1).max(4096),
    old_string: z.string().min(1).max(MAX_EDIT_FILE_BYTES),
    new_string: z.string().max(MAX_EDIT_FILE_BYTES),
    replace_all: z.boolean().optional().default(false),
    worktree: WorktreeSelector,
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
  args: z.infer<typeof EditArgs>,
): Promise<
  | { result: FileEditOutput; text: string }
  | {
      message: string;
      code?: string;
      details?: unknown;
      detailsUiOnly?: boolean;
    }
> {
  const {
    old_string: oldString,
    new_string: newString,
    replace_all: replaceAll,
  } = args;
  try {
    const existing = await readExisting(target.abs);
    if (existing === null) {
      // Edit is edit-only; a missing file has nothing to search, so it
      // fails like any unmatched string.
      return { message: editNotFoundError(oldString) };
    }
    const applied = applyEditToContent(
      existing,
      oldString,
      newString,
      replaceAll,
    );
    if (!applied.ok) {
      if (applied.reason === "not_found") {
        const suggestion = findClosestMatch(existing, oldString);
        if (suggestion === null) {
          // No window cleared the thresholds — exactly today's text.
          return { message: editNotFoundError(oldString) };
        }
        return {
          message: editNotFoundError(oldString, suggestionHint(suggestion)),
          code: "edit_failed",
          details: { suggestion },
          // The message is the complete model-facing text; code/details
          // stay in the envelope for the UI only.
          detailsUiOnly: true,
        };
      }
      return { message: "new_string must be different from old_string" };
    }
    const content = applied.content;
    await writeFile(target.abs, content);
    const hunks = structuredPatch("a", "b", existing, content, "", "", {
      context: 3,
    }).hunks;
    const result: FileEditOutput = {
      filePath: target.abs,
      oldString: oldString,
      newString,
      originalFile: existing,
      structuredPatch: hunks,
      userModified: false,
      replaceAll,
    };
    if (applied.lenient !== undefined)
      result.lenientTabEating = applied.lenient;
    result.replacedLines = applied.replacedLines;
    result.shift = applied.shift;
    if (await isGitRepo(cwd)) {
      result.gitDiff = gitDiffFor(
        "update",
        target.rel,
        existing,
        content,
        hunks,
      );
    }
    const shiftText =
      applied.shift.by === 0
        ? ""
        : ` Lines after ${applied.shift.after} shift by ${applied.shift.by >= 0 ? "+" : ""}${applied.shift.by}.`;
    return {
      result,
      text: editConfirmation(replaceAll, rawFilePath) + shiftText,
    };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
      code: "edit_failed",
    };
  }
}

export function buildEditTool(
  workspaceRoot: string,
  ctx?: WorktreeToolContext,
): PortalTool {
  const treeFor = createTreeResolver(workspaceRoot, ctx);
  return {
    name: "edit",
    description: "Replace exact text in an existing workspace file.",
    promptGuidelines: [
      "Fails (leaving the file unchanged) when the `old_string` is not found — the error may include the closest matching region ('Did you mean') to help correct the edit.",
      "`old_string` locates the edit by exact content (not line numbers), mirroring `multi_edit`. Use `multi_edit` for multi-hunk or multi-file edits.",
    ],
    argsSchema: EditArgs,
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Absolute or workspace-relative path.",
        },
        old_string: {
          type: "string",
          description:
            "Exact text to replace — usually the first line of the block to replace.",
        },
        new_string: {
          type: "string",
          description: "Replacement text.",
        },
        replace_all: {
          type: "boolean",
          description: "Replace every occurrence of old_string. Default false.",
        },
        worktree: WORKTREE_WRITE_PARAM,
      },
      required: ["file_path", "old_string", "new_string"],
      additionalProperties: false,
    },
    derivePermissionRequest(args) {
      const parsed = EditArgs.safeParse(args);
      if (!parsed.success) return null;
      const root = parsed.data.worktree
        ? resolveWorktreeDir(parsed.data.worktree, ctx)
        : workspaceRoot;
      const path = root && resolveAbsoluteTarget(root, parsed.data.file_path);
      return path ? { permissionKind: "edit", path } : null;
    },
    async handler(args) {
      const parsed = EditArgs.parse(args);
      const tree = treeFor(parsed.worktree);
      if (tree.error) return tree.error;
      const target = resolveWriteTarget(tree.cwd, parsed.file_path);
      if (!target.ok) return err(target.message, { code: "invalid_path" });
      const outcome = await performEdit(
        tree.cwd,
        target,
        parsed.file_path,
        parsed,
      );
      if ("message" in outcome) {
        if (!outcome.code) return err(outcome.message);
        return err(outcome.message, {
          code: outcome.code,
          ...(outcome.details !== undefined
            ? { details: outcome.details }
            : {}),
          ...(outcome.detailsUiOnly !== undefined
            ? { detailsUiOnly: outcome.detailsUiOnly }
            : {}),
        });
      }
      return ok(outcome.result, outcome.text, {
        views: [{ type: "text", text: outcome.text }],
      });
    },
  };
}
