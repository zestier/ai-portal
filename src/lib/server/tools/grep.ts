import { relative } from "node:path";
import { ripgrep } from "ripgrep";
import { z } from "zod";
import { resolveGrantedTarget } from "./filesystem";
import { err, ok, type PortalTool, type ToolPermissionRequest } from "./types";
import {
  createTreeResolver,
  resolveWorktreeDir,
  WorktreeSelector,
  WORKTREE_PARAM,
  type WorktreeToolContext,
} from "./worktree-selector";

const MAX_GREP_OUTPUT_BYTES = 100_000;
const GrepOutputMode = z.enum(["content", "files_with_matches", "count"]);

// Mirrors the Agent SDK's GrepInput so the aliased SDK `Grep` tool (which sends
// these field names verbatim) parses cleanly.
const GrepArgs = z
  .object({
    pattern: z.string().min(1).max(4096),
    path: z.string().min(1).max(4096).optional(),
    glob: z.string().max(512).optional(),
    output_mode: GrepOutputMode.optional().default("files_with_matches"),
    "-B": z.number().int().min(0).optional(),
    "-A": z.number().int().min(0).optional(),
    "-C": z.number().int().min(0).optional(),
    context: z.number().int().min(0).optional(),
    "-n": z.boolean().optional().default(true),
    "-i": z.boolean().optional().default(false),
    "-o": z.boolean().optional().default(false),
    type: z.string().max(64).optional(),
    head_limit: z.number().int().min(0).optional().default(250),
    offset: z.number().int().min(0).optional().default(0),
    multiline: z.boolean().optional().default(false),
    include_ignored: z.boolean().optional().default(false),
    worktree: WorktreeSelector,
  })
  .strict();

type GrepArgsParsed = z.infer<typeof GrepArgs>;

// The portal's projection of the SDK GrepOutput contract, plus an internal
// `truncated` flag for when the 100KB output cap bit (the SDK has no field for
// it, so the renderer surfaces it as a marker). Fields the search cannot
// cheaply derive (content-mode per-file stats) are simply omitted.
export interface GrepResult {
  mode: "content" | "files_with_matches" | "count";
  numFiles?: number;
  filenames?: string[];
  content?: string;
  numLines?: number;
  numMatches?: number;
  totalFiles?: number;
  totalLines?: number;
  appliedLimit?: number;
  appliedOffset?: number;
  truncated?: boolean;
}

function resolveTarget(
  root: string,
  rawPath: string | undefined,
): string | null {
  const target = resolveGrantedTarget(root, rawPath ?? ".");
  return target.ok ? target.abs : null;
}

// Truncate a filename list so the joined output stays under `maxBytes`; the
// byte cap mirrors the old bounded-output guarantee (no GrepOutput field
// carries it, so the renderer appends a marker when `truncated` is true).
function capList(
  paths: string[],
  maxBytes: number,
): { paths: string[]; truncated: boolean } {
  const out: string[] = [];
  let len = 0;
  for (const p of paths) {
    const added = Buffer.byteLength(p) + (out.length > 0 ? 1 : 0);
    if (len + added > maxBytes) return { paths: out, truncated: true };
    out.push(p);
    len += added;
  }
  return { paths: out, truncated: false };
}

function capContent(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  return {
    text:
      buf.subarray(0, maxBytes).toString("utf8") +
      "\n...[truncated: results exceed 100KB]",
    truncated: true,
  };
}

function relativePath(cwd: string, p: string): string {
  return relative(cwd, p).replaceAll("\\", "/");
}

// Content lines are prefixed with the path exactly as rg was given it, which
// is the absolute `target`. Relativize that prefix (and drop rg's `./` for a
// `.` target) so output is workspace-relative like files/count modes.
function relativizeContentLine(cwd: string, line: string): string {
  const abs = cwd.replace(/\/+$/, "") + "/";
  if (line.startsWith(abs)) return line.slice(abs.length);
  return line.startsWith("./") ? line.slice(2) : line;
}

function capEntries(
  entries: { path: string; count: number }[],
  maxBytes: number,
): { entries: { path: string; count: number }[]; truncated: boolean } {
  const out: { path: string; count: number }[] = [];
  let len = 0;
  for (const e of entries) {
    const added = Buffer.byteLength(e.path) + (out.length > 0 ? 1 : 0);
    if (len + added > maxBytes) return { entries: out, truncated: true };
    out.push(e);
    len += added;
  }
  return { entries: out, truncated: false };
}

async function searchGrep(
  cwd: string,
  target: string,
  args: GrepArgsParsed,
): Promise<GrepResult> {
  const mode = args.output_mode;
  const rgArgs = ["--color", "never"];
  if (mode === "files_with_matches") {
    rgArgs.push("--files-with-matches");
  } else if (mode === "count") {
    rgArgs.push("--count-matches");
  } else {
    // content: rg-style path:line:content, one match per line.
    rgArgs.push("--no-heading", "--with-filename");
    if (args["-n"]) rgArgs.push("--line-number");
    if (args["-o"]) rgArgs.push("--only-matching");
  }
  if (args["-i"]) rgArgs.push("--ignore-case");
  if (args.multiline) rgArgs.push("--multiline");
  const ctx = args.context ?? args["-C"] ?? 0;
  const before = args["-B"] ?? ctx;
  const after = args["-A"] ?? ctx;
  if (before > 0) rgArgs.push("--before-context", String(before));
  if (after > 0) rgArgs.push("--after-context", String(after));
  if (args.type) rgArgs.push("--type", args.type);
  if (args.glob) rgArgs.push("--glob", args.glob);
  if (args.include_ignored) rgArgs.push("--no-ignore");
  rgArgs.push(args.pattern, target);

  const { code, stdout, stderr } = await ripgrep(rgArgs, {
    buffer: true,
    nodeWasi: false,
    preopens: { ".": cwd },
  });
  if (code !== 0 && code !== 1) {
    throw new Error(stderr || stdout || "grep failed");
  }

  const head = args.head_limit > 0 ? args.offset + args.head_limit : undefined;
  const appliedLimit = args.head_limit > 0 ? args.head_limit : undefined;
  const appliedOffset = args.offset > 0 ? args.offset : undefined;

  if (mode === "content") {
    const lines = stdout.split(/\r?\n/);
    if (lines[lines.length - 1] === "") lines.pop();
    const relLines = lines.map((line) => relativizeContentLine(cwd, line));
    const sliced = relLines.slice(args.offset, head);
    const { text, truncated } = capContent(
      sliced.join("\n"),
      MAX_GREP_OUTPUT_BYTES,
    );
    return {
      mode,
      content: text, // capContent embeds the truncation marker
      numLines: sliced.length,
      totalLines: lines.length,
      ...(appliedLimit !== undefined ? { appliedLimit } : {}),
      ...(appliedOffset !== undefined ? { appliedOffset } : {}),
      ...(truncated ? { truncated: true } : {}),
    };
  }

  const rawPaths = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((p) => relativePath(cwd, p));
  const totalFiles = rawPaths.length;
  const sliced = rawPaths.slice(args.offset, head);
  const { paths: files, truncated } = capList(sliced, MAX_GREP_OUTPUT_BYTES);

  if (mode === "files_with_matches") {
    return {
      mode,
      numFiles: files.length,
      filenames: files,
      totalFiles,
      ...(appliedLimit !== undefined ? { appliedLimit } : {}),
      ...(appliedOffset !== undefined ? { appliedOffset } : {}),
      ...(truncated ? { truncated: true } : {}),
    };
  }

  // count: per-file counts from `path:count` (or a bare `count` when the
  // target is a single file).
  const rawEntries = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const match = /^(.*):(\d+)$/.exec(line);
      if (match) {
        return {
          path: relativePath(cwd, match[1]),
          count: Number.parseInt(match[2], 10),
        };
      }
      return {
        path: relativePath(cwd, target),
        count: Number.parseInt(line, 10),
      };
    });
  const totalLines = rawEntries.reduce((sum, e) => sum + e.count, 0);
  const slicedEntries = rawEntries.slice(args.offset, head);
  const { entries: kept, truncated: capped } = capEntries(
    slicedEntries,
    MAX_GREP_OUTPUT_BYTES,
  );
  const numMatches = kept.reduce((sum, e) => sum + e.count, 0);
  return {
    mode,
    numFiles: kept.length,
    filenames: kept.map((e) => e.path),
    numMatches,
    totalFiles: rawEntries.length,
    totalLines,
    ...(appliedLimit !== undefined ? { appliedLimit } : {}),
    ...(appliedOffset !== undefined ? { appliedOffset } : {}),
    ...(capped ? { truncated: true } : {}),
  };
}

// The text a model sees for a GrepOutput, mirroring the SDK's rendering.
export function renderGrepResult(result: GrepResult): string {
  if (result.mode === "count") {
    if ((result.numMatches ?? 0) === 0) {
      return "No matches found\n\nFound 0 total occurrences across 0 files.";
    }
    return `Found ${result.numMatches} total occurrences across ${result.numFiles ?? 0} files.`;
  }
  if (result.mode === "content") {
    return result.content ?? "";
  }
  const numFiles = result.numFiles ?? 0;
  const lines = [`Found ${numFiles} file${numFiles === 1 ? "" : "s"}`];
  if (result.filenames && result.filenames.length > 0)
    lines.push(...result.filenames);
  if (result.truncated) lines.push("[truncated: results exceed 100KB]");
  return lines.join("\n");
}

export function buildGrepTools(
  workspaceRoot: string,
  ctx?: WorktreeToolContext,
): PortalTool[] {
  const treeFor = createTreeResolver(workspaceRoot, ctx);
  const permissionRoot = (worktree: string | undefined) =>
    worktree ? resolveWorktreeDir(worktree, ctx) : workspaceRoot;

  return [
    {
      name: "grep",
      description:
        "Search text with ripgrep (content | files_with_matches | count).",
      promptGuidelines: [
        "Respects .gitignore; filesystem read grants govern the target path.",
      ],
      argsSchema: GrepArgs,
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: {
            type: "string",
            description: "Workspace-relative file or directory.",
          },
          glob: { type: "string" },
          output_mode: {
            type: "string",
            enum: GrepOutputMode.options,
          },
          "-B": {
            type: "number",
            description: "Lines before a match.",
          },
          "-A": {
            type: "number",
            description: "Lines after a match.",
          },
          "-C": {
            type: "number",
            description: "Lines around a match.",
          },
          context: {
            type: "number",
            description: "Lines around each match.",
          },
          "-n": { type: "boolean" },
          "-i": { type: "boolean" },
          "-o": {
            type: "boolean",
            description: "Only matched parts, one per line.",
          },
          type: {
            type: "string",
            description: "rg --type, e.g. js.",
          },
          head_limit: {
            type: "number",
            description: "Max lines/entries; 0 = unlimited.",
          },
          offset: {
            type: "number",
          },
          multiline: { type: "boolean" },
          include_ignored: {
            type: "boolean",
            description: "Bypass ripgrep ignore files.",
          },
          worktree: WORKTREE_PARAM,
        },
        required: ["pattern"],
        additionalProperties: false,
      },
      derivePermissionRequest(args): ToolPermissionRequest | null {
        const parsed = GrepArgs.safeParse(args);
        if (!parsed.success) return null;
        const root = permissionRoot(parsed.data.worktree);
        const path = root && resolveTarget(root, parsed.data.path);
        return path ? { permissionKind: "read", path } : null;
      },
      async handler(args) {
        const parsed = GrepArgs.parse(args);
        const tree = treeFor(parsed.worktree);
        if (tree.error) return tree.error;
        const target = resolveTarget(tree.cwd, parsed.path);
        if (!target)
          return err("path could not be resolved", {
            code: "invalid_path",
          });
        try {
          const result = await searchGrep(tree.cwd, target, parsed);
          return ok(result, "Search completed.", {
            views: [{ type: "text", text: renderGrepResult(result) }],
          });
        } catch (error) {
          return err(error instanceof Error ? error.message : String(error), {
            code: "grep_failed",
          });
        }
      },
    },
  ];
}
