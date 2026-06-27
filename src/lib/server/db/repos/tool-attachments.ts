// Repository for `tool_attachments` — binary artifacts (currently images
// captured for a native `view`) side-stored away from `tool_calls.result_json`.
//
// Read paths never SELECT the `data` BLOB except the single authed
// byte-serving endpoint (`getForOwner`): listing and hydration return metadata
// only so the hot message/tool-call queries stay light.

import type Database from 'better-sqlite3';
import { ulid } from '../ids';
import { getDb } from '../index';
import type { ToolAttachmentMeta } from '$lib/types';

export interface InsertToolAttachment {
	toolCallId: string;
	kind: 'image';
	mimeType: string;
	byteSize: number;
	sourcePath: string | null;
	data: Buffer;
}

export function insert(input: InsertToolAttachment): string {
	const id = ulid();
	getDb()
		.prepare(
			`INSERT INTO tool_attachments(
			   id, tool_call_id, kind, mime_type, byte_size, source_path, data, created_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			id,
			input.toolCallId,
			input.kind,
			input.mimeType,
			input.byteSize,
			input.sourcePath,
			input.data,
			Date.now()
		);
	return id;
}

interface MetaRow {
	id: string;
	tool_call_id: string;
	kind: string;
	mime_type: string;
	byte_size: number;
}

function rowToMeta(r: MetaRow): ToolAttachmentMeta {
	return {
		id: r.id,
		toolCallId: r.tool_call_id,
		kind: 'image',
		mimeType: r.mime_type,
		byteSize: r.byte_size
	};
}

/** Metadata (no bytes) for a single tool call's attachments, oldest first. */
export function listMetaForToolCall(toolCallId: string): ToolAttachmentMeta[] {
	const rows = getDb()
		.prepare(
			`SELECT id, tool_call_id, kind, mime_type, byte_size
			   FROM tool_attachments WHERE tool_call_id = ? ORDER BY created_at ASC, id ASC`
		)
		.all(toolCallId) as MetaRow[];
	return rows.map(rowToMeta);
}

/**
 * Metadata (no bytes) for many tool calls at once, grouped by tool_call_id.
 * Batches the IN-list to stay under SQLite's bound-parameter cap.
 */
export function listMetaForToolCalls(
	toolCallIds: readonly string[]
): Map<string, ToolAttachmentMeta[]> {
	const out = new Map<string, ToolAttachmentMeta[]>();
	if (toolCallIds.length === 0) return out;
	const db = getDb();
	const BATCH = 500;
	for (let i = 0; i < toolCallIds.length; i += BATCH) {
		const batch = toolCallIds.slice(i, i + BATCH);
		const placeholders = batch.map(() => '?').join(',');
		const rows = db
			.prepare(
				`SELECT id, tool_call_id, kind, mime_type, byte_size
				   FROM tool_attachments WHERE tool_call_id IN (${placeholders})
				  ORDER BY created_at ASC, id ASC`
			)
			.all(...batch) as MetaRow[];
		for (const r of rows) {
			const meta = rowToMeta(r);
			(out.get(meta.toolCallId) ?? out.set(meta.toolCallId, []).get(meta.toolCallId)!).push(meta);
		}
	}
	return out;
}

export interface AttachmentBytes {
	mimeType: string;
	byteSize: number;
	data: Buffer;
}

/**
 * Fetch an attachment's bytes only if it belongs to `userId` (via its tool call
 * → message → conversation owner) AND lives in `conversationId`. Returns null
 * on any mismatch so the endpoint can 404 without leaking existence.
 */
export function getForOwner(
	conversationId: string,
	toolCallId: string,
	attachmentId: string,
	userId: string
): AttachmentBytes | null {
	const row = getDb()
		.prepare(
			`SELECT ta.mime_type, ta.byte_size, ta.data
			   FROM tool_attachments ta
			   JOIN tool_calls tc ON tc.id = ta.tool_call_id
			   JOIN messages m ON m.id = tc.message_id
			   JOIN conversations c ON c.id = m.conversation_id
			  WHERE ta.id = ?
			    AND ta.tool_call_id = ?
			    AND m.conversation_id = ?
			    AND c.user_id = ?`
		)
		.get(attachmentId, toolCallId, conversationId, userId) as
		| { mime_type: string; byte_size: number; data: Buffer }
		| undefined;
	if (!row) return null;
	return { mimeType: row.mime_type, byteSize: row.byte_size, data: row.data };
}

// Test helper: count rows for a tool call (used to assert cascade cleanup).
export function _countForToolCall(db: Database.Database, toolCallId: string): number {
	const r = db
		.prepare('SELECT COUNT(*) AS n FROM tool_attachments WHERE tool_call_id = ?')
		.get(toolCallId) as { n: number };
	return r.n;
}
