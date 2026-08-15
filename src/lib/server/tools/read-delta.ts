// Experiment (token-experiment branch, T38): delta-aware reads. Keeps a
// per-conversation store of `path → content hash + snapshot`; a re-read of an
// unchanged file returns a short marker instead of re-echoing the content, and
// a changed file returns only the line-diff hunks. Appends new content instead
// of rewriting history, so it plays nice with prefix caches.
import { stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { structuredPatch } from 'diff';
import type { Hunk } from 'diff';
import { z } from 'zod';
import { sniffImageMime } from '../image-detect';
import { resolveReadTarget, readFileResult } from './read';
import { err, ok, type PortalTool, type ToolPermissionRequest, type ToolResult } from './types';
import { resolveAbsoluteTarget } from './filesystem';
import {
	createTreeResolver,
	resolveWorktreeDir,
	WorktreeSelector,
	WORKTREE_PARAM,
	type WorktreeToolContext
} from './worktree-selector';

const MAX_DELTA_FILE_BYTES = 5_000_000;

const ReadDeltaArgs = z
	.object({
		file_path: z.string().min(1).max(4096),
		worktree: WorktreeSelector
	})
	.strict();

interface DeltaRecord {
	hash: string;
	content: string;
	mtimeMs: number;
}

// ponytail: module-level Map, process-lifetime, per-conversation+path keys.
// Ceiling: unbounded growth on a long-lived process if reads never repeat;
// upgrade to a DB or a per-conversation LRU when sessions get long. Entry cap
// evicts oldest first (Map preserves insertion order).
const deltaStore = new Map<string, DeltaRecord>();
const MAX_DELTA_ENTRIES = 50;

function deltaKey(conversationId: unknown, abs: string): string {
	return `${conversationId ?? 'default'}:${abs}`;
}

function storeDelta(key: string, record: DeltaRecord): void {
	deltaStore.set(key, record);
	if (deltaStore.size > MAX_DELTA_ENTRIES) {
		const oldest = deltaStore.keys().next().value;
		if (oldest !== undefined) deltaStore.delete(oldest);
	}
}

function renderDelta(
	rel: string,
	oldHash: string,
	newHash: string,
	oldLines: number,
	newLines: number,
	hunks: Hunk[]
): string {
	const shift = newLines - oldLines;
	const delta = shift >= 0 ? `+${shift}` : String(shift);
	const out: string[] = [];
	out.push(
		`read_delta: ${rel} changed since last read (${oldHash} → ${newHash}, ${oldLines} → ${newLines} lines, shift ${delta}).`
	);
	for (const h of hunks) {
		out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
		out.push(...h.lines);
	}
	out.push('Delta only — read an offset:limit range for full lines.');
	return out.join('\n');
}

async function deltaResult(
	conversationId: unknown,
	cwd: string,
	filePath: string
): Promise<ToolResult> {
	const resolved = resolveReadTarget(cwd, filePath);
	if (!resolved.ok) return err(resolved.message);
	const { abs, rel } = resolved;
	try {
		const fileStat = await stat(abs);
		if (fileStat.isDirectory()) {
			return err(`Path is a directory, not a file: ${rel}`);
		}
		if (fileStat.size > MAX_DELTA_FILE_BYTES) {
			return err(
				`File is too large to read safely (${fileStat.size} bytes; limit is ${MAX_DELTA_FILE_BYTES}).`
			);
		}
		const buf = await readFile(abs);
		if (sniffImageMime(buf.subarray(0, 16)) !== null) {
			return readFileResult(cwd, filePath, { offset: 1, limit: Number.MAX_SAFE_INTEGER });
		}
		const content = buf.toString('utf8');
		if (content.includes('\0')) {
			return err(`File contains null bytes and is likely binary: ${rel}`);
		}
		const hash = createHash('sha1').update(content).digest('hex').slice(0, 8);
		const key = deltaKey(conversationId, abs);
		const record = deltaStore.get(key);

		if (record === undefined) {
			storeDelta(key, { hash, content, mtimeMs: fileStat.mtimeMs });
			return readFileResult(cwd, filePath, { offset: 1, limit: Number.MAX_SAFE_INTEGER });
		}
		if (record.hash === hash) {
			const totalLines = content.split(/\r?\n/).length;
			const text = `read_delta: ${rel} unchanged since last read (hash ${hash}, ${totalLines} lines). Content is already in context — don't re-read; read an offset:limit range only if you need it again.`;
			return ok(
				{
					type: 'unchanged',
					file_path: rel,
					hash,
					total_lines: totalLines,
					size: fileStat.size
				},
				`Unchanged: ${rel}`,
				{ views: [{ type: 'text', text }] }
			);
		}
		const oldLines = record.content.split(/\r?\n/).length;
		const newLines = content.split(/\r?\n/).length;
		const hunks = structuredPatch('a', 'b', record.content, content, '', '', { context: 2 }).hunks;
		storeDelta(key, { hash, content, mtimeMs: fileStat.mtimeMs });
		const text = renderDelta(rel, record.hash, hash, oldLines, newLines, hunks);
		return ok(
			{
				type: 'delta',
				file_path: rel,
				old_hash: record.hash,
				new_hash: hash,
				old_lines: oldLines,
				new_lines: newLines,
				shift: newLines - oldLines,
				hunks
			},
			`Delta: ${rel}`,
			{ views: [{ type: 'text', text }] }
		);
	} catch (e) {
		if (e instanceof Error && 'code' in e && e.code === 'ENOENT') {
			return err(`File does not exist. Note: your current working directory is ${cwd}.`);
		}
		return err(e instanceof Error ? e.message : String(e));
	}
}

export function buildReadDeltaTools(
	workspaceRoot: string,
	ctx?: WorktreeToolContext
): PortalTool[] {
	const treeFor = createTreeResolver(workspaceRoot, ctx);
	const permissionRoot = (worktree: string | undefined) =>
		worktree ? resolveWorktreeDir(worktree, ctx) : workspaceRoot;
	return [
		{
			name: 'read_delta',
			description:
				'Read a file, returning only the changes if you have read it before in this session (or a short marker if unchanged). Use for re-reads to avoid re-sending whole files.',
			promptGuidelines: [
				'First read returns the full file (and records its hash). Later reads: `unchanged` marker or delta hunks only.',
				'If you dropped the earlier content from context and need it again, read an offset:limit range — the delta alone may not be enough.',
				'Line numbers from a `delta` are the new ones; combine with `outline`/`edit_range` for navigation.'
			],
			argsSchema: ReadDeltaArgs,
			parameters: {
				type: 'object',
				properties: {
					file_path: {
						type: 'string',
						description: 'Path (absolute or workspace-relative).'
					},
					worktree: WORKTREE_PARAM
				},
				required: ['file_path'],
				additionalProperties: false
			},
			derivePermissionRequest(args): ToolPermissionRequest | null {
				const parsed = ReadDeltaArgs.safeParse(args);
				if (!parsed.success) return null;
				const root = permissionRoot(parsed.data.worktree);
				if (root === null) return null;
				const abs = resolveAbsoluteTarget(root, parsed.data.file_path);
				if (abs === null) return null;
				return { permissionKind: 'read', path: abs };
			},
			async handler(args) {
				const parsed = ReadDeltaArgs.parse(args);
				const tree = treeFor(parsed.worktree);
				if (tree.error) return tree.error;
				return deltaResult(ctx?.conversationId, tree.cwd, parsed.file_path);
			}
		}
	];
}
