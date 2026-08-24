import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import {
  isPathInWorkspace,
  resolveWithParentFallback,
} from "../permissions/workspace";
import { sniffImageMime } from "../image-detect";
import { resolveAbsoluteTarget } from "./filesystem";
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
  WORKTREE_PARAM,
  type WorktreeToolContext,
} from "./worktree-selector";
import { computeOutline, renderOutline } from "./outline";
import {
  parseTicketPath,
  resolveTicketPath,
  ticketFileContent,
} from "./ticket-file";
// Mirrors the Agent SDK's FileReadInput (sdk-tools.d.ts) so the aliased SDK
// `Read` tool (which sends these field names verbatim) parses cleanly.
const ReadArgs = z
  .object({
    file_path: z.string().min(1).max(4096),
    offset: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).optional(),
    numbered: z.boolean().optional(),
    mode: z.enum(["auto", "outline", "content"]).optional(),
    worktree: WorktreeSelector,
  })
  .strict();

// Hard ceiling on a single read (range reads load the file into memory). Matches
// the other portal file tools' 5MB bound.
const MAX_READ_FILE_BYTES = 5_000_000;
// Numbered rendering of a selected range larger than this is paginated to a
// first page with a continuation banner (the SDK's token-cap auto-pagination).
const MAX_READ_RESULT_BYTES = 200_000;
// T38 experiment: reads return an indentation outline by default — the model's
// `read` reflex becomes cheap without it learning to reach for a new tool, and
// intent (not file size) drives the behavior. Exceptions: `full: true` asks for
// raw content; files at or below FLOOR lines (an outline can't beat a full read
// there); and targeted ranges (<= MAX_RANGE lines) which are the drill-in after
// an outline.
const OUTLINE_READ_FLOOR = 40;
const OUTLINE_READ_MAX_RANGE = 60;

// The SDK's FileReadOutput image union only carries these raster mimes. BMP/SVG
// are recognized images in this portal but fall outside the contract, so they
// are NOT read as images (they fall through to the binary/text path).
const SDK_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

// The portal's projection of the SDK FileReadOutput text union (sdk-tools.d.ts),
// plus `size` kept as a portal extension. `content` is the raw file text of the
// selected range; the model-facing rendering (plain by default, numbered when
// `numbered: true`) is attached as `views`.
export interface FileReadTextOutput {
  type: "text";
  file: {
    filePath: string;
    content: string;
    numLines: number;
    startLine: number;
    totalLines: number;
    truncatedByTokenCap?: boolean;
    size: number;
  };
}

// The SDK FileReadOutput image union. `dimensions` is optional in the contract;
// the portal does not parse image headers, so it is omitted.
export interface FileReadImageOutput {
  type: "image";
  file: {
    base64: string;
    type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    originalSize: number;
  };
}

// Resolve a Read `file_path` to an absolute, symlink-resolved target inside the
// workspace. Accepts both the SDK contract's absolute paths and
// workspace-relative paths (as the tests use), rejecting any `..` escape that
// resolves outside the root. Mirrors `resolveWriteTarget` in edit-file.ts — same
// resolver, different tool. Exported so the outline tool reuses the same
// workspace-containment rules.
export function resolveReadTarget(
  workspaceRoot: string,
  rawPath: string,
): { ok: true; abs: string; rel: string } | { ok: false; message: string } {
  if (rawPath.includes("\0")) {
    return { ok: false, message: "path must not contain NUL characters" };
  }
  const root = resolveWithParentFallback(resolve(workspaceRoot));
  if (root === null) {
    return { ok: false, message: "could not resolve the workspace root" };
  }
  const abs = resolveWithParentFallback(
    isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath),
  );
  if (abs === null) {
    return { ok: false, message: `could not resolve path: ${rawPath}` };
  }
  if (!isPathInWorkspace(abs, root)) {
    return { ok: false, message: `path escapes the workspace: ${rawPath}` };
  }
  return { ok: true, abs, rel: abs === root ? "." : relative(root, abs) };
}

// The numbered rendering a model sees for a read when `numbered: true`: one
// `<lineNumber>\t<content>` per line.
function renderNumberedLines(lines: string[], startLine: number): string {
  return lines.map((line, i) => `${startLine + i}\t${line}`).join("\n");
}

// The continuation banner prepended when a read is auto-paginated to a first
// page. `offset` echoes the count covered so far (reads begin at line 1).
function paginationBanner(
  numLines: number,
  totalLines: number,
  end: number,
): string {
  const pct = totalLines === 0 ? 100 : Math.round((end / totalLines) * 100);
  return `Read ${numLines} lines (${pct}% complete)... continue with offset=${end}`;
}

// Largest exclusive end index (into `lines`) whose rendering from `startLine`
// fits under `capBytes`, so a too-large page is trimmed deterministically. The
// per-line byte cost is measured in the active prefix mode (numbered or plain).
function paginateEnd(
  lines: string[],
  startLine: number,
  capBytes: number,
  numbered: boolean,
): number {
  let used = 0;
  let i = startLine - 1;
  for (; i < lines.length; i += 1) {
    const sep = used === 0 ? 0 : 1;
    const lineBytes = Buffer.byteLength(
      numbered ? `${i + 1}\t${lines[i]}` : lines[i],
    );
    if (used + sep + lineBytes > capBytes) break;
    used += sep + lineBytes;
  }
  return i;
}

function readImageResult(
  rel: string,
  mime: string,
  buf: Buffer,
  originalSize: number,
): ToolResult {
  const base64 = buf.toString("base64");
  return ok(
    { type: "image", file: { base64, type: mime, originalSize } },
    `Read file: ${rel}`,
    {
      views: [
        { type: "image", data: base64, mimeType: mime, description: rel },
      ],
    },
  );
}

// T38 experiment: broad reads of large files return an indentation outline
// (header + blocks + tail) instead of the raw content, so the model navigates a
// big file without pulling it whole into context. Returns null when the file has
// no usable indentation structure (flat/minified), so the caller falls back to
// the normal paginated read. Dynamic import avoids a static cycle with
// outline.ts (which imports readFileResult).
async function outlineRead(
  rel: string,
  content: string,
  totalLines: number,
  size: number,
  hash: string,
): Promise<ToolResult | null> {
  const outline = computeOutline(content);
  if (outline.format !== "normal" || outline.blocks.length === 0) return null;
  // Identity only; the drill-in instruction lives once, at the outline's end.
  const banner = `read: ${rel} — ${totalLines} lines (outline, ${size} bytes, hash ${hash}).\n\n`;
  const body = banner + renderOutline(outline);
  return ok(
    {
      type: "text",
      file: {
        filePath: rel,
        content: body,
        numLines: body.split("\n").length,
        startLine: 1,
        totalLines,
        size,
        outlined: true,
        outline: outline.blocks,
      },
    },
    `Read file: ${rel} (outline)`,
    { views: [{ type: "text", text: body }] },
  );
}

export async function readFileResult(
  cwd: string,
  filePath: string,
  req: {
    offset?: number;
    limit?: number;
    numbered?: boolean;
    mode?: "auto" | "outline" | "content";
  } = {},
): Promise<ToolResult> {
  const resolved = resolveReadTarget(cwd, filePath);
  if (!resolved.ok) return err(resolved.message);
  const { abs, rel } = resolved;
  try {
    const fileStat = await stat(abs);
    if (fileStat.isDirectory()) {
      return err(`Path is a directory, not a file: ${rel}`);
    }
    if (fileStat.size > MAX_READ_FILE_BYTES) {
      return err(
        `File is too large to read safely (${fileStat.size} bytes; limit is ${MAX_READ_FILE_BYTES}).`,
      );
    }
    const buf = await readFile(abs);
    const sniffed = sniffImageMime(buf.subarray(0, 16));
    if (sniffed !== null && SDK_IMAGE_MIMES.has(sniffed)) {
      return readImageResult(rel, sniffed, buf, fileStat.size);
    }
    const content = buf.toString("utf8");
    if (content.includes("\0")) {
      return err(`File contains null bytes and is likely binary: ${rel}`);
    }
    const hash = createHash("sha1").update(content).digest("hex").slice(0, 8);
    const lines = content.split(/\r?\n/);
    const totalLines = lines.length;
    // offset/limit default to the whole file: a range-less read is broad, so
    // auto-mode outlines large files anyway and small files just return
    // their full content.
    const offset = req.offset ?? 1;
    const limit = req.limit ?? totalLines;
    // mode: 'outline' always outlines; 'content' always returns raw; auto
    // (default) outlines non-tiny files read broadly, keeping targeted
    // ranges (<= MAX_RANGE lines) raw as the drill-in.
    const wantOutline =
      req.mode === "outline" ||
      ((req.mode === undefined || req.mode === "auto") &&
        totalLines > OUTLINE_READ_FLOOR &&
        limit > OUTLINE_READ_MAX_RANGE);
    if (wantOutline) {
      const outlined = await outlineRead(
        rel,
        content,
        totalLines,
        fileStat.size,
        hash,
      );
      if (outlined !== null) return outlined;
    }
    const numbered = req.numbered === true;
    const startLine = offset;
    let end = Math.min(totalLines, startLine + limit - 1);
    let truncatedByTokenCap = false;
    if (
      Buffer.byteLength(
        numbered
          ? renderNumberedLines(lines.slice(startLine - 1, end), startLine)
          : lines.slice(startLine - 1, end).join("\n"),
      ) > MAX_READ_RESULT_BYTES
    ) {
      truncatedByTokenCap = true;
      end = paginateEnd(lines, startLine, MAX_READ_RESULT_BYTES, numbered);
    }
    const sliced = lines.slice(startLine - 1, end);
    const numLines = sliced.length;
    const rendered = numbered
      ? renderNumberedLines(sliced, startLine)
      : sliced.join("\n");
    const body = truncatedByTokenCap
      ? `${paginationBanner(numLines, totalLines, end)}\n${rendered}`
      : rendered;
    const views =
      rendered.trim().length === 0
        ? undefined
        : [
            {
              type: "text" as const,
              text: `${body}\n(file has ${totalLines} total lines)`,
            },
          ];
    return ok(
      {
        type: "text",
        file: {
          filePath: rel,
          content: sliced.join("\n"),
          numLines,
          startLine,
          totalLines,
          ...(truncatedByTokenCap ? { truncatedByTokenCap: true } : {}),
          size: fileStat.size,
        },
      },
      `Read file: ${rel}`,
      views ? { views } : undefined,
    );
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") {
      return err(
        `File does not exist. Note: your current working directory is ${cwd}.`,
      );
    }
    return err(e instanceof Error ? e.message : String(e));
  }
}

// Read a ticket virtual file. Returns the serialized ticket content
// with a banner if the path scopes to a status that doesn't match.
async function readTicketFileResult(
  resolution: Exclude<ReturnType<typeof parseTicketPath>, null>,
  offset: number | undefined,
  limit: number | undefined,
  numbered: boolean | undefined,
  userId: number | undefined,
  workspaceKey: string | undefined,
): Promise<ToolResult> {
  if (!userId || !workspaceKey) {
    return err("ticket: paths require a session context (userId/workspaceKey)");
  }
  if (resolution.kind === "folder") {
    return err(
      "ticket:open is a grep folder, not a readable file — use grep with path=ticket:open",
    );
  }
  const { ticket, statusMismatch } = resolveTicketPath(resolution, userId);
  if (!ticket) {
    return err(`Ticket not found: ${resolution.ticketId}`);
  }
  if (statusMismatch) {
    // Scoped lookup on a non-open ticket: resolve it but warn.
    const content = ticketFileContent(ticket);
    const banner = `Warning: ticket ${ticket.id} has status "${ticket.status}", not "open". Showing content anyway.\n\n`;
    const fullContent = banner + content;
    const lines = fullContent.split(/\r?\n/);
    const totalLines = lines.length;
    const startLine = offset ?? 1;
    const end = limit
      ? Math.min(totalLines, startLine + limit - 1)
      : totalLines;
    const sliced = lines.slice(startLine - 1, end);
    const rendered = numbered
      ? sliced.map((l, i) => `${startLine + i}\t${l}`).join("\n")
      : sliced.join("\n");
    return ok(
      {
        type: "text",
        file: {
          filePath: `ticket:${resolution.ticketId}`,
          content: rendered,
          numLines: sliced.length,
          startLine,
          totalLines,
          size: Buffer.byteLength(fullContent),
        },
      },
      `Read ticket file: ticket:${resolution.ticketId}`,
      { views: [{ type: "text", text: rendered }] },
    );
  }
  const content = ticketFileContent(ticket);
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;
  const startLine = offset ?? 1;
  const end = limit ? Math.min(totalLines, startLine + limit - 1) : totalLines;
  const sliced = lines.slice(startLine - 1, end);
  const rendered = numbered
    ? sliced.map((l, i) => `${startLine + i}\t${l}`).join("\n")
    : sliced.join("\n");
  return ok(
    {
      type: "text",
      file: {
        filePath: `ticket:${resolution.ticketId}`,
        content: rendered,
        numLines: sliced.length,
        startLine,
        totalLines,
        size: Buffer.byteLength(content),
      },
    },
    `Read ticket file: ticket:${resolution.ticketId}`,
    { views: [{ type: "text", text: rendered }] },
  );
}

export function buildReadTools(
  workspaceRoot: string,
  ctx?: WorktreeToolContext,
): PortalTool[] {
  const treeFor = createTreeResolver(workspaceRoot, ctx);
  const permissionRoot = (worktree: string | undefined) =>
    worktree ? resolveWorktreeDir(worktree, ctx) : workspaceRoot;

  return [
    {
      name: "read",
      description: "Read a file's content (text paging or an image).",
      promptGuidelines: [
        "Reads return plain text by default; pass `numbered: true` to prefix each line with `<lineNumber>\t`. For text, `offset`/`limit` are optional and default to the whole file (a range-less read of a large file returns an outline).",
        "Images (jpeg/png/gif/webp) return as an image and ignore `offset`/`limit`. Errors on binary files or directories.",
        `Files over ${OUTLINE_READ_FLOOR} lines return an indentation outline (header + blocks + tail) by default (mode auto). Pass mode:'content' for raw content, mode:'outline' to force structure, or read a targeted offset:limit range (up to ${OUTLINE_READ_MAX_RANGE} lines) for a block body.`,
      ],
      argsSchema: ReadArgs,
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Path (absolute or workspace-relative).",
          },
          offset: {
            type: "number",
            description: "1-indexed start line. Optional; defaults to 1.",
          },
          limit: {
            type: "number",
            description: "Lines to read. Optional; defaults to the whole file.",
          },
          numbered: {
            type: "boolean",
            description: "Prefix each line with `<lineNumber>\t`.",
          },
          mode: {
            type: "string",
            enum: ["auto", "outline", "content"],
            description:
              "Read mode. 'auto' (default) outlines non-tiny files read with a broad range; 'outline' always returns the structure; 'content' returns raw content for the requested range.",
          },
          worktree: WORKTREE_PARAM,
        },
        // offset/limit are optional: a range-less read defaults to the whole
        // file (and auto-mode outlines large files), and image reads always
        // ignore them.
        required: ["file_path"],
        additionalProperties: false,
      },
      derivePermissionRequest(args): ToolPermissionRequest | null {
        const parsed = ReadArgs.safeParse(args);
        if (!parsed.success) return null;
        if (parseTicketPath(parsed.data.file_path)) return null;
        const root = permissionRoot(parsed.data.worktree);
        if (root === null) return null;
        const abs = resolveAbsoluteTarget(root, parsed.data.file_path);
        if (abs === null) return null;
        return { permissionKind: "read", path: abs };
      },
      async handler(args) {
        const parsed = ReadArgs.parse(args);
        const ticketPath = parseTicketPath(parsed.file_path);
        if (ticketPath) {
          const tree = treeFor(parsed.worktree);
          if (tree.error) return tree.error;
          return readTicketFileResult(
            ticketPath,
            parsed.offset,
            parsed.limit,
            parsed.numbered,
            ctx?.userId,
            ctx?.workspaceKey,
          );
        }
        const tree = treeFor(parsed.worktree);
        if (tree.error) return tree.error;
        return readFileResult(tree.cwd, parsed.file_path, {
          ...(parsed.offset !== undefined ? { offset: parsed.offset } : {}),
          ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
          ...(parsed.numbered !== undefined
            ? { numbered: parsed.numbered }
            : {}),
          ...(parsed.mode !== undefined ? { mode: parsed.mode } : {}),
        });
      },
    },
  ];
}
