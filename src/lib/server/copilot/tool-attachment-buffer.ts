// In-memory staging buffer for captured image attachments.
//
// Why a buffer (and not a direct DB write at capture time): the portal captures
// image bytes at permission (read) time, but the `tool_calls` row the
// attachment must reference doesn't exist yet — it is created later, on
// `tool.execution_start`. The SDK lifecycle is onPreToolUse → permission →
// execute → execution_start → execution_complete, and the row is persisted on
// execution_start (see turn-runner `tool.call` handling). So we stage the bytes
// here keyed by a correlation key, then flush to `tool_attachments` once the FK
// target exists.
//
// Correlation key: the permission request's `toolCallId` when present (it
// equals the execution's toolCallId), else `${conversationId}\0${absPath}`
// matched against the next read execution_start in the same conversation.
//
// Lifecycle / leak guard: an entry is consumed (removed) on flush, dropped when
// the read is denied/cancelled, and the whole map is bounded — inserting past
// the cap evicts the oldest entry. The bound is the backstop for the rare case
// where a captured read never reaches an execution_start (so it is neither
// flushed nor dropped): such an entry is eventually evicted as newer ones land.

import { appGlobalSymbols, getOrCreateGlobalSingleton } from '../global-singleton';

export interface BufferedAttachment {
	kind: 'image';
	mimeType: string;
	data: Buffer;
	sourcePath: string;
	bufferedAt: number;
}

// Generous but bounded: a single turn rarely views more than a handful of
// images before they're flushed, but cap it so a pathological run (many
// auto-allowed reads whose tools never start) can't grow unboundedly.
const MAX_BUFFERED_ENTRIES = 64;

const BUFFER_KEYS = appGlobalSymbols('tool-attachment-buffer');

function store(): Map<string, BufferedAttachment> {
	return getOrCreateGlobalSingleton(BUFFER_KEYS, () => new Map<string, BufferedAttachment>());
}

export function toolCallKey(toolCallId: string): string {
	return `tc\0${toolCallId}`;
}

export function pathKey(conversationId: string, absPath: string): string {
	return `cp\0${conversationId}\0${absPath}`;
}

/**
 * Stage an attachment under every provided correlation key. Evicts the oldest
 * entry first when the map is at capacity.
 */
export function bufferAttachment(keys: string[], att: BufferedAttachment): void {
	if (keys.length === 0) return;
	const map = store();
	while (map.size + keys.length > MAX_BUFFERED_ENTRIES && map.size > 0) {
		const oldest = map.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		map.delete(oldest);
	}
	for (const key of keys) map.set(key, att);
}

/**
 * Remove and return the first staged attachment matching any of `keys`. All the
 * provided keys are deleted (an entry is staged under several keys), so a
 * consumed attachment can't be flushed twice.
 */
export function takeAttachment(keys: string[]): BufferedAttachment | null {
	const map = store();
	let found: BufferedAttachment | null = null;
	for (const key of keys) {
		const v = map.get(key);
		if (v && !found) found = v;
		map.delete(key);
	}
	return found;
}

/** Drop staged attachments under the given keys without returning them. */
export function dropAttachment(keys: string[]): void {
	const map = store();
	for (const key of keys) map.delete(key);
}

// Test-only: inspect / reset buffer state.
export function _bufferSize(): number {
	return store().size;
}
export function _clearBuffer(): void {
	store().clear();
}
