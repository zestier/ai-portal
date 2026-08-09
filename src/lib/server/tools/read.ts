import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { isPathInWorkspace, resolveWithParentFallback } from '../permissions/workspace';
import { sniffImageMime } from '../image-detect';
import { resolveAbsoluteTarget } from './filesystem';
import {
	deriveToolResultViews,
	err,
	ok,
	type PortalTool,
	type ToolPermissionRequest,
	type ToolResult
} from './types';
import {
	createTreeResolver,
	resolveWorktreeDir,
	WorktreeSelector,
	WORKTREE_PARAM,
	type WorktreeToolContext
} from './worktree-selector';

// Mirrors the Agent SDK's FileReadInput (sdk-tools.d.ts) so the aliased SDK
// `Read` tool (which sends these field names verbatim) parses cleanly.
// `file_path` is absolute per the SDK contract; `resolveReadTarget` below also
// accepts workspace-relative paths so tests and golden replays work unchanged.
const ReadArgs = z
	.object({
		file_path: z.string().min(1).max(4096),
		offset: z.number().int().min(1).optional(),
		limit: z.number().int().min(1).optional(),
		pages: z.string().max(64).optional(),
		worktree: WorktreeSelector
	})
	.strict();

// Hard ceiling on a single read (whole-file reads and range reads both load the
// file into memory). Matches the other portal file tools' 5MB bound.
const MAX_READ_FILE_BYTES = 5_000_000;
// Whole-file reads (no offset/limit) above this byte cap error, mirroring the
// SDK built-in: "File content (X KB) exceeds maximum allowed size (256KB)."
// The SDK formats the size in KiB while labeling it KB (908,894 B -> 887.6KB).
const MAX_WHOLE_READ_BYTES = 256 * 1024;
// Numbered rendering of a selected range larger than this is paginated to a
// first page with a continuation banner (the SDK's token-cap auto-pagination).
const MAX_READ_RESULT_BYTES = 200_000;

// The SDK's FileReadOutput image union only carries these raster mimes. BMP/SVG
// are recognized images in this portal but fall outside the contract, so they
// are NOT read as images (they fall through to the binary/text path).
const SDK_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// The portal's projection of the SDK FileReadOutput text union (sdk-tools.d.ts),
// plus `size` kept as a portal extension. `content` is the raw file text of the
// selected range; the model-facing numbered rendering is attached as `views`.
export interface FileReadTextOutput {
	type: 'text';
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
	type: 'image';
	file: {
		base64: string;
		type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
		originalSize: number;
	};
}

// Resolve a Read `file_path` to an absolute, symlink-resolved target inside the
// workspace. Accepts both the SDK contract's absolute paths and
// workspace-relative paths (as the golden capture used), rejecting any `..`
// escape that resolves outside the root. Mirrors `resolveWriteTarget` in
// edit-file.ts — same resolver, different tool.
function resolveReadTarget(
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

// The SDK formats sizes in KiB but labels them KB (golden Read/large:
// "File content (887.6KB)" for a 908,894-byte file).
function formatKb(bytes: number): string {
	return `${(bytes / 1024).toFixed(1)}KB`;
}

// The numbered rendering a model sees for a read, matching the golden capture:
// one `<lineNumber>\t<content>` per line.
function renderNumberedLines(lines: string[], startLine: number): string {
	return lines.map((line, i) => `${startLine + i}\t${line}`).join('\n');
}

// The continuation banner the SDK prepends when a read is auto-paginated to a
// first page. `offset` echoes the count covered so far (starting reads begin at
// line 1), matching the golden format "Read 100 lines (25% complete)...".
function paginationBanner(numLines: number, totalLines: number, end: number): string {
	const pct = totalLines === 0 ? 100 : Math.round((end / totalLines) * 100);
	return `Read ${numLines} lines (${pct}% complete)... continue with offset=${end}`;
}

// Largest exclusive end index (into `lines`) whose numbered rendering from
// `startLine` fits under `capBytes`, so a too-large page is trimmed deterministically.
function paginateEnd(lines: string[], startLine: number, capBytes: number): number {
	let used = 0;
	let i = startLine - 1;
	for (; i < lines.length; i += 1) {
		const sep = used === 0 ? 0 : 1;
		const lineBytes = Buffer.byteLength(`${i + 1}\t${lines[i]}`);
		if (used + sep + lineBytes > capBytes) break;
		used += sep + lineBytes;
	}
	return i;
}

function readImageResult(rel: string, mime: string, buf: Buffer, originalSize: number): ToolResult {
	const base64 = buf.toString('base64');
	return ok({ type: 'image', file: { base64, type: mime, originalSize } }, `Read file: ${rel}`, {
		views: [{ type: 'image', data: base64, mimeType: mime, description: rel }]
	});
}

// Shared by the tool handler and the golden conformance renderer so the
// model-facing text cannot drift between the two paths.
export async function readFileResult(
	cwd: string,
	filePath: string,
	offset?: number,
	limit?: number
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
				`File is too large to read safely (${fileStat.size} bytes; limit is ${MAX_READ_FILE_BYTES}).`
			);
		}
		const buf = await readFile(abs);
		const sniffed = sniffImageMime(buf.subarray(0, 16));
		if (sniffed !== null && SDK_IMAGE_MIMES.has(sniffed)) {
			return readImageResult(rel, sniffed, buf, fileStat.size);
		}
		const content = buf.toString('utf8');
		if (content.includes('\0')) {
			return err(`File contains null bytes and is likely binary: ${rel}`);
		}
		if (offset === undefined && limit === undefined && fileStat.size > MAX_WHOLE_READ_BYTES) {
			return err(
				`File content (${formatKb(fileStat.size)}) exceeds maximum allowed size (256KB). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`
			);
		}
		const lines = content.split(/\r?\n/);
		const totalLines = lines.length;
		const startLine = offset ?? 1;
		let end = limit !== undefined ? Math.min(totalLines, startLine + limit - 1) : totalLines;
		let truncatedByTokenCap = false;
		if (
			Buffer.byteLength(renderNumberedLines(lines.slice(startLine - 1, end), startLine)) >
			MAX_READ_RESULT_BYTES
		) {
			truncatedByTokenCap = true;
			end = paginateEnd(lines, startLine, MAX_READ_RESULT_BYTES);
		}
		const sliced = lines.slice(startLine - 1, end);
		const numLines = sliced.length;
		const numbered = renderNumberedLines(sliced, startLine);
		const views =
			numbered.trim().length === 0
				? undefined
				: [
						{
							type: 'text' as const,
							text: truncatedByTokenCap
								? `${paginationBanner(numLines, totalLines, end)}\n${numbered}`
								: numbered
						}
					];
		return ok(
			{
				type: 'text',
				file: {
					filePath: rel,
					content: sliced.join('\n'),
					numLines,
					startLine,
					totalLines,
					...(truncatedByTokenCap ? { truncatedByTokenCap: true } : {}),
					size: fileStat.size
				}
			},
			`Read file: ${rel}`,
			views ? { views } : undefined
		);
	} catch (e) {
		if (e instanceof Error && 'code' in e && e.code === 'ENOENT') {
			return err(`File does not exist. Note: your current working directory is ${cwd}.`);
		}
		return err(e instanceof Error ? e.message : String(e));
	}
}

// The text a model sees for a Read call (used by the golden conformance
// registry; the tool handler reuses `readFileResult`).
export async function renderReadModelText(
	args: Record<string, unknown>,
	cwd: string
): Promise<string> {
	const parsed = ReadArgs.parse(args);
	if (parsed.pages !== undefined) {
		throw new Error('pages is only supported for PDF files, which this read tool does not render.');
	}
	const result = await readFileResult(cwd, parsed.file_path, parsed.offset, parsed.limit);
	return deriveToolResultViews(result).modelText;
}

export function buildReadTools(workspaceRoot: string, ctx?: WorktreeToolContext): PortalTool[] {
	const treeFor = createTreeResolver(workspaceRoot, ctx);
	const permissionRoot = (worktree: string | undefined) =>
		worktree ? resolveWorktreeDir(worktree, ctx) : workspaceRoot;

	return [
		{
			name: 'read',
			description:
				'Read the content of a file in the workspace, mirroring the SDK Read contract. `file_path` is the absolute path of the file to read (workspace-relative paths also resolve). `offset`/`limit` return a 1-indexed line range; whole-file reads of files larger than 256KB error, so pass offset/limit for those. Text files render numbered lines; image files (jpeg/png/gif/webp) are returned as an image the model can see. Pass `worktree` to read inside a worktree this conversation holds instead. Errors on binary files or directories.',
			argsSchema: ReadArgs,
			parameters: {
				type: 'object',
				properties: {
					file_path: {
						type: 'string',
						description: 'The absolute path to the file to read (workspace-relative also accepted).'
					},
					offset: {
						type: 'number',
						description: 'The 1-indexed line number to start reading from.'
					},
					limit: {
						type: 'number',
						description: 'The number of lines to read.'
					},
					pages: {
						type: 'string',
						description:
							'Page range for PDF files. Unsupported: this read tool does not render PDFs.'
					},
					worktree: WORKTREE_PARAM
				},
				required: ['file_path'],
				additionalProperties: false
			},
			derivePermissionRequest(args): ToolPermissionRequest | null {
				const parsed = ReadArgs.safeParse(args);
				if (!parsed.success) return null;
				const root = permissionRoot(parsed.data.worktree);
				if (root === null) return null;
				const abs = resolveAbsoluteTarget(root, parsed.data.file_path);
				if (abs === null) return null;
				return { permissionKind: 'read', path: abs };
			},
			async handler(args) {
				const parsed = ReadArgs.parse(args);
				if (parsed.pages !== undefined) {
					return err(
						'pages is only supported for PDF files, which this read tool does not render.'
					);
				}
				const tree = treeFor(parsed.worktree);
				if (tree.error) return tree.error;
				return readFileResult(tree.cwd, parsed.file_path, parsed.offset, parsed.limit);
			}
		}
	];
}
