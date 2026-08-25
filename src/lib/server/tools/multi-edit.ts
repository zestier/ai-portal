// `multi_edit`: an atomic batch of exact-text edits, replacing the removed
// `apply_patch` tool. Agents routinely produced malformed unified diffs for
// apply_patch (wrong hunk counts, missing /dev/null headers, botched rename
// metadata); emitting the same `{file_path, old_string, new_string,
// replace_all?}` objects the `edit` tool already uses is trivially reliable.
//
// Semantics:
//   - Atomic all-or-nothing. Every edit validates against in-memory file
//     content BEFORE anything is written; a failing edit aborts the batch with
//     no file changed, and the error names the failing edit's index, path, and
//     the unmatched `old_string`. (The removed apply_patch was fail-fast with
//     partial writes — deliberately not replicated.)
//   - Edits apply sequentially within a file: edit N's `old_string` matches
//     against the content after edits 1..N−1, identical to repeated `edit`
//     calls. First occurrence replaced unless `replace_all: true`.
//   - Replacement-only. Create/delete/rename stay in `write`/`trash`/`move`;
//     `new_string: ""` is a valid truncation (matches `edit`).
//   - Each referenced file is read at most once; changed files are written only
//     after the whole batch validates.
//
// The replace math and the FileEditOutput projection are shared with `edit`
// (see ./edit-file) so the two tools cannot drift.

import { writeFile } from "node:fs/promises";
import { structuredPatch } from "diff";
import { z } from "zod";
import { isGitRepo } from "../git";
import { resolveAbsoluteTarget } from "./filesystem";
import {
  applyEditToContent,
  findClosestMatch,
  gitDiffFor,
  MAX_EDIT_FILE_BYTES,
  MAX_MULTI_EDIT_PAYLOAD_BYTES,
  readExisting,
  resolveWriteTarget,
  suggestionHint,
  type FileEditOutput,
} from "./edit-file/common";
import { parseTicketPath } from "./ticket-file";
import {
  err,
  ok,
  type PortalTool,
  type ToolPermissionRequest,
  type ToolResult,
} from "./types";
import {
  createTreeResolver,
  resolveWorktreeDir,
  WorktreeSelector,
  WORKTREE_WRITE_PARAM,
  type WorktreeToolContext,
} from "./worktree-selector";

const MAX_MULTI_EDIT_EDITS = 100;

// The per-edit object mirrors the `edit` tool's args exactly (minus `worktree`,
// which is a batch-level param) so an agent can lift a working single edit into
// a batch without reshaping it.
const EditOp = z
  .object({
    file_path: z.string().min(1).max(4096),
    old_string: z.string().min(1).max(MAX_EDIT_FILE_BYTES),
    new_string: z.string().max(MAX_EDIT_FILE_BYTES),
    replace_all: z.boolean().optional().default(false),
  })
  .strict();

const MultiEditArgs = z
  .object({
    edits: z.array(EditOp).min(1).max(MAX_MULTI_EDIT_EDITS),
    worktree: WorktreeSelector,
    dryRun: z.boolean().optional().default(false),
  })
  .strict()
  .superRefine((data, ctx) => {
    // Total JSON payload cap, mirroring the legacy apply_patch patch limit:
    // the per-string caps alone would let 100 edits smuggle ~1GB through the
    // permission layer. `worktree`/`dryRun` add a handful of bytes on top of
    // `edits`; measuring the array keeps the bound honest about the payload.
    const payload = JSON.stringify(data.edits);
    if (payload.length > MAX_MULTI_EDIT_PAYLOAD_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["edits"],
        message: `edits payload exceeds the ${MAX_MULTI_EDIT_PAYLOAD_BYTES} byte limit`,
      });
    }
  });

type Target = { abs: string; rel: string };

// Error text for a failing edit: 0-based index into the `edits` array, the
// caller's path, and the failure reason (for an unmatched `old_string`, the
// unmatched string itself). `details` (the closest-match suggestion, when one
// clears the threshold) rides the envelope for the UI; `detailsUiOnly` marks it
// as UI-only so the message stays the complete model-facing text.
function editError(
  index: number,
  filePath: string,
  message: string,
  details?: unknown,
  detailsUiOnly?: boolean,
): ToolResult {
  return err(`edits[${index}] (${filePath}): ${message}`, {
    code: "edit_failed",
    ...(details !== undefined ? { details } : {}),
    ...(detailsUiOnly !== undefined ? { detailsUiOnly } : {}),
  });
}

// The model-facing confirmation, mirroring `edit`'s wording (the diffs live in
// the envelope's per-edit FileEditOutput entries for the UI).
function multiEditConfirmation(editCount: number, fileCount: number): string {
  return `Applied ${editCount} edit(s) across ${fileCount} file(s). (file state is current in your context — no need to Read it back)`;
}

export function buildMultiEditTools(
  workspaceRoot: string,
  ctx?: WorktreeToolContext,
): PortalTool[] {
  const treeFor = createTreeResolver(workspaceRoot, ctx);
  return [
    {
      name: "multi_edit",
      description:
        "Apply an atomic batch (1–100) of exact-text edits; all-or-nothing.",
      promptGuidelines: [
        "Every `old_string` must match the file contents; if any edit fails, nothing is written (the error names the failing edit index, path, and unmatched string — a 'Did you mean' closest-match hint may be included).",
        "Edits apply sequentially per file — edit N matches content after edits 1..N−1 — and `new_string` may be empty to delete text.",
        "Replacement-only: use `write`/`trash`/`move` for create/delete/rename. Anchor on content, never line numbers. `dryRun` validates without writing.",
      ],
      argsSchema: MultiEditArgs,
      parameters: {
        type: "object",
        properties: {
          edits: {
            type: "array",
            description: "Exact-text edits (1–100).",
            items: {
              type: "object",
              properties: {
                file_path: {
                  type: "string",
                  description:
                    "Absolute path; must resolve inside the workspace.",
                },
                old_string: {
                  type: "string",
                },
                new_string: {
                  type: "string",
                  description: "Replacement text (may be empty).",
                },
                replace_all: {
                  type: "boolean",
                  description: "Replace every occurrence. Default false.",
                },
              },
              required: ["file_path", "old_string", "new_string"],
              additionalProperties: false,
            },
          },
          worktree: WORKTREE_WRITE_PARAM,
          dryRun: { type: "boolean", description: "Validate without writing." },
        },
        required: ["edits"],
        additionalProperties: false,
      },
      derivePermissionRequest(args): ToolPermissionRequest | null {
        const parsed = MultiEditArgs.safeParse(args);
        if (!parsed.success) return null;
        for (const edit of parsed.data.edits) {
          if (parseTicketPath(edit.file_path)) return null;
        }
        const root = parsed.data.worktree
          ? resolveWorktreeDir(parsed.data.worktree, ctx)
          : workspaceRoot;
        if (root === null) return null;
        // Gate on EVERY target (first + additionalPaths), like `move` and the
        // removed apply_patch: the gateway evaluates each against the user's
        // grants + policy and combines most-restrictively. A multi-target
        // request is never persistable from the prompt — per-call grant only.
        const paths: string[] = [];
        for (const edit of parsed.data.edits) {
          const abs = resolveAbsoluteTarget(root, edit.file_path);
          if (abs === null) return null;
          paths.push(abs);
        }
        const [firstPath, ...additionalPaths] = paths;
        if (!firstPath) return null;
        return { permissionKind: "edit", path: firstPath, additionalPaths };
      },
      async handler(args) {
        const parsed = MultiEditArgs.parse(args);
        for (const edit of parsed.edits) {
          if (parseTicketPath(edit.file_path)) {
            return err(
              "ticket: paths are not supported in multi_edit — use the edit tool instead.",
            );
          }
        }
        const tree = treeFor(parsed.worktree);
        if (tree.error) return tree.error;
        const cwd = tree.cwd;

        // Resolve every target up front so an escaping path aborts before
        // anything is read or written.
        const targets: Target[] = [];
        for (let i = 0; i < parsed.edits.length; i++) {
          const edit = parsed.edits[i]!;
          const target = resolveWriteTarget(cwd, edit.file_path);
          if (!target.ok) {
            return err(`edits[${i}] (${edit.file_path}): ${target.message}`, {
              code: "invalid_path",
            });
          }
          targets.push(target);
        }

        const gitRepo = await isGitRepo(cwd);

        // Apply every edit in order against in-memory content. Each file is
        // read at most once (on first reference); nothing is written until the
        // whole batch validates.
        const initialContents = new Map<string, string>();
        const currentContents = new Map<string, string>();
        const outputs: FileEditOutput[] = [];
        for (let i = 0; i < parsed.edits.length; i++) {
          const edit = parsed.edits[i]!;
          const target = targets[i]!;
          let current = currentContents.get(target.abs);
          if (current === undefined) {
            let existing: string | null;
            try {
              existing = await readExisting(target.abs);
            } catch (error) {
              return editError(
                i,
                edit.file_path,
                error instanceof Error ? error.message : String(error),
              );
            }
            if (existing === null) {
              return editError(i, edit.file_path, "file not found");
            }
            initialContents.set(target.abs, existing);
            current = existing;
          }
          const applied = applyEditToContent(
            current,
            edit.old_string,
            edit.new_string,
            edit.replace_all,
          );
          if (!applied.ok) {
            if (applied.reason === "not_found") {
              // The failing edit matches against `current` (content after
              // edits 1..N−1), so the closest-match hint must reflect that
              // same content.
              const suggestion = findClosestMatch(current, edit.old_string);
              if (suggestion === null) {
                return editError(
                  i,
                  edit.file_path,
                  `string to replace not found.\nString: ${edit.old_string}`,
                );
              }
              return editError(
                i,
                edit.file_path,
                `string to replace not found.\nString: ${edit.old_string}\n${suggestionHint(suggestion)}`,
                { suggestion },
                true,
              );
            }
            return editError(
              i,
              edit.file_path,
              "new_string must be different from old_string",
            );
          }
          currentContents.set(target.abs, applied.content);

          const hunks = structuredPatch(
            "a",
            "b",
            current,
            applied.content,
            "",
            "",
            {
              context: 3,
            },
          ).hunks;
          const output: FileEditOutput = {
            filePath: target.abs,
            oldString: edit.old_string,
            newString: edit.new_string,
            originalFile: current,
            structuredPatch: hunks,
            userModified: false,
            replaceAll: edit.replace_all,
          };
          if (applied.lenient !== undefined)
            output.lenientTabEating = applied.lenient;
          output.replacedLines = applied.replacedLines;
          output.shift = applied.shift;
          if (gitRepo) {
            output.gitDiff = gitDiffFor(
              "update",
              target.rel,
              current,
              applied.content,
              hunks,
            );
          }
          outputs.push(output);
        }

        const fileCount = initialContents.size;

        if (parsed.dryRun) {
          return ok(
            {
              dryRun: true,
              edits: parsed.edits.map((edit, i) => ({
                filePath: targets[i]!.abs,
                oldString: edit.old_string,
                newString: edit.new_string,
                replaceAll: edit.replace_all,
              })),
            },
            `Validated ${parsed.edits.length} edit(s) across ${fileCount} file(s).`,
          );
        }

        // The whole batch validated — only now touch disk, and only files that
        // actually changed (a later edit may have reverted an earlier one).
        for (const [abs, finalContent] of currentContents) {
          if (initialContents.get(abs) !== finalContent) {
            await writeFile(abs, finalContent);
          }
        }

        const summary = `Applied ${parsed.edits.length} edit(s) across ${fileCount} file(s).`;
        return ok({ edits: outputs, summary }, summary, {
          views: [
            {
              type: "text",
              text: multiEditConfirmation(parsed.edits.length, fileCount),
            },
          ],
        });
      },
    },
  ];
}
