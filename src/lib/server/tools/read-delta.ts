import { structuredPatch } from 'diff';
import type { Hunk } from 'diff';
import { ok, type ToolResult } from './types';

// Delta reads (T38): keep a per-conversation snapshot so a broad re-read of an
// unchanged file returns a short marker and a changed file returns only the
// line-diff hunks — no re-sending whole files. Appends new content instead of
// rewriting history, so it plays nice with prefix caches.
// ponytail: module-level Map, process-lifetime, per-conversation+path keys.
// Ceiling: unbounded growth on a long-lived process if reads never repeat;
// upgrade to a DB or a per-conversation LRU when sessions get long. Entry cap
// evicts oldest first (Map preserves insertion order).
export interface DeltaRecord {
	hash: string;
	content: string;
	mtimeMs: number;
}
export const deltaStore = new Map<string, DeltaRecord>();
export const MAX_DELTA_ENTRIES = 50;

export function deltaKey(conversationId: unknown, abs: string): string {
	return `${conversationId ?? 'default'}:${abs}`;
}

export function storeDelta(key: string, record: DeltaRecord): void {
	deltaStore.set(key, record);
	if (deltaStore.size > MAX_DELTA_ENTRIES) {
		const oldest = deltaStore.keys().next().value;
		if (oldest !== undefined) deltaStore.delete(oldest);
	}
}

export function renderDelta(
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
		`read: ${rel} changed since your last read (${oldHash} → ${newHash}, ${oldLines} → ${newLines} lines, shift ${delta}).`
	);
	for (const h of hunks) {
		out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
		out.push(...h.lines);
	}
	out.push('Delta only — read an offset:limit range for full lines.');
	return out.join('\n');
}

// A broad re-read of an unchanged file: a short marker instead of re-echoing
// content. The message is guidance (drill in / mode:'content'), not a claim
// that every body is in context.
export function unchangedReadResult(
	rel: string,
	hash: string,
	totalLines: number,
	size: number
): ToolResult {
	const text =
		`read: ${rel} unchanged since your last read (hash ${hash}, ${totalLines} lines) — no need to ` +
		`re-read; use a targeted offset:limit range for a body, or mode:'content' for raw content.`;
	return ok(
		{ type: 'unchanged', file_path: rel, hash, total_lines: totalLines, size },
		`Unchanged: ${rel}`,
		{ views: [{ type: 'text', text }] }
	);
}

// A broad re-read of a changed file: only the line-diff hunks against the
// previous snapshot.
export function deltaReadResult(
	rel: string,
	record: DeltaRecord,
	content: string,
	newHash: string,
	newLines: number
): ToolResult {
	const oldLines = record.content.split(/\r?\n/).length;
	const hunks = structuredPatch('a', 'b', record.content, content, '', '', { context: 2 }).hunks;
	const text = renderDelta(rel, record.hash, newHash, oldLines, newLines, hunks);
	return ok(
		{
			type: 'delta',
			file_path: rel,
			old_hash: record.hash,
			new_hash: newHash,
			old_lines: oldLines,
			new_lines: newLines,
			shift: newLines - oldLines,
			hunks
		},
		`Delta: ${rel}`,
		{ views: [{ type: 'text', text }] }
	);
}
