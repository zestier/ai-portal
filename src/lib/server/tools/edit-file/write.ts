import { mkdir, writeFile } from "node:fs/promises";
import { structuredPatch } from "diff";
import { dirname } from "node:path";
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
  gitDiffFor,
  MAX_EDIT_FILE_BYTES,
  readExisting,
  resolveWriteTarget,
  type FileWriteGitDiff,
  type FileWriteStructuredPatch,
} from "./common";
import { parseTicketPath } from "../ticket-file";

// Mirrors the SDK WriteInput so the aliased SDK `Write` tool (which sends
// `file_path`/`content` verbatim) parses cleanly. `file_path` is absolute per
// the SDK contract; the resolver below also accepts workspace-relative paths so
// tests (which pass relative paths) work unchanged.
export const WriteArgs = z
  .object({
    file_path: z.string().min(1).max(4096),
    content: z.string().max(MAX_EDIT_FILE_BYTES),
    worktree: WorktreeSelector,
  })
  .strict();

export interface FileWriteOutput {
  type: "create" | "update";
  filePath: string;
  content: string;
  structuredPatch: FileWriteStructuredPatch[];
  originalFile: string | null;
  gitDiff?: FileWriteGitDiff;
  userModified?: boolean;
}

// The text a model sees for a FileWriteOutput, mirroring the SDK's rendering.
// The path is echoed verbatim from the call, matching the SDK (which renders
// the input path as given).
function writeConfirmation(
  type: "create" | "update",
  rawFilePath: string,
): string {
  return type === "create"
    ? `File created successfully at: ${rawFilePath} (file state is current in your context — no need to Read it back)`
    : `The file ${rawFilePath} has been updated successfully. (file state is current in your context — no need to Read it back)`;
}

// The write itself plus the SDK FileWriteOutput projection and the model-facing
// confirmation text. `rawFilePath` is what the caller passed (absolute or
// relative) and is echoed verbatim in the confirmation, matching the SDK's
// rendering. `cwd` gates the gitDiff (only reported inside a git work tree).
async function performWrite(
  cwd: string,
  target: { abs: string; rel: string },
  rawFilePath: string,
  content: string,
): Promise<{ result: FileWriteOutput; text: string } | { message: string }> {
  try {
    const existing = await readExisting(target.abs);
    const type: "create" | "update" = existing === null ? "create" : "update";
    await mkdir(dirname(target.abs), { recursive: true });
    // `wx` on create keeps the fail-if-someone-else-won-the-race guard from
    // the old create_file tool; updates overwrite deliberately (SDK Write).
    await writeFile(target.abs, content, {
      encoding: "utf8",
      flag: existing === null ? "wx" : "w",
    });
    const oldContent = existing ?? "";
    const hunks = structuredPatch("a", "b", oldContent, content, "", "", {
      context: 3,
    }).hunks;
    const result: FileWriteOutput = {
      type,
      filePath: target.abs,
      content,
      structuredPatch: hunks,
      originalFile: existing,
    };
    if (await isGitRepo(cwd)) {
      result.gitDiff = gitDiffFor(type, target.rel, oldContent, content, hunks);
    }
    return { result, text: writeConfirmation(type, rawFilePath) };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return { message: `file already exists: ${rawFilePath}` };
    }
    return { message: error instanceof Error ? error.message : String(error) };
  }
}

export function buildWriteTool(
  workspaceRoot: string,
  ctx?: WorktreeToolContext,
): PortalTool {
  const treeFor = createTreeResolver(workspaceRoot, ctx);
  return {
    name: "write",
    description: "Write text content to a file, creating or replacing it.",
    promptGuidelines: [
      "`content` is the complete new text. Result reports created/updated plus a structured diff.",
    ],
    argsSchema: WriteArgs,
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Absolute or workspace-relative path.",
        },
        content: { type: "string" },
        worktree: WORKTREE_WRITE_PARAM,
      },
      required: ["file_path", "content"],
      additionalProperties: false,
    },
    derivePermissionRequest(args) {
      const parsed = WriteArgs.safeParse(args);
      if (!parsed.success) return null;
      if (parseTicketPath(parsed.data.file_path)) return null;
      const root = parsed.data.worktree
        ? resolveWorktreeDir(parsed.data.worktree, ctx)
        : workspaceRoot;
      const path = root && resolveAbsoluteTarget(root, parsed.data.file_path);
      return path ? { permissionKind: "write", path } : null;
    },
    async handler(args) {
      const parsed = WriteArgs.parse(args);
      if (parseTicketPath(parsed.file_path)) {
        return err(
          "Writing to ticket: paths is not supported — use edit to modify ticket content.",
        );
      }
      const tree = treeFor(parsed.worktree);
      if (tree.error) return tree.error;
      const target = resolveWriteTarget(tree.cwd, parsed.file_path);
      if (!target.ok) return err(target.message, { code: "invalid_path" });
      const outcome = await performWrite(
        tree.cwd,
        target,
        parsed.file_path,
        parsed.content,
      );
      if ("message" in outcome)
        return err(outcome.message, { code: "write_failed" });
      return ok(outcome.result, outcome.text, {
        views: [{ type: "text", text: outcome.text }],
      });
    },
  };
}
