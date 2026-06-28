// Repository for `ticket_attachments` — binary files attached to workspace
// tickets (screenshots, logs, traces, arbitrary blobs). Mirrors the
// tool-attachments repo pattern: read paths never SELECT the `data` BLOB
// except the single authed byte-serving endpoint (`getForOwner`).

import type Database from 'better-sqlite3';
import { ulid } from '../ids';
import { getDb } from '../index';
import type { TicketAttachmentMeta } from '$lib/types';

export const MAX_BYTE_SIZE = 10 * 1024 * 1024; // 10 MB
export const MAX_PER_TICKET = 20;

export interface InsertTicketAttachment {
	ticketId: string;
	filename: string;
	mimeType: string;
	byteSize: number;
	sourcePath: string | null;
	data: Buffer;
}

export function insert(input: InsertTicketAttachment): TicketAttachmentMeta {
	const id = ulid();
	const now = Date.now();
	getDb()
		.prepare(
			`INSERT INTO ticket_attachments(id, ticket_id, filename, mime_type, byte_size, source_path, data, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			id,
			input.ticketId,
			input.filename,
			input.mimeType,
			input.byteSize,
			input.sourcePath,
			input.data,
			now
		);
	return {
		id,
		ticketId: input.ticketId,
		filename: input.filename,
		mimeType: input.mimeType,
		byteSize: input.byteSize,
		createdAt: now
	};
}

interface MetaRow {
	id: string;
	ticket_id: string;
	filename: string;
	mime_type: string;
	byte_size: number;
	created_at: number;
}

function rowToMeta(r: MetaRow): TicketAttachmentMeta {
	return {
		id: r.id,
		ticketId: r.ticket_id,
		filename: r.filename,
		mimeType: r.mime_type,
		byteSize: r.byte_size,
		createdAt: r.created_at
	};
}

/** Metadata (no bytes) for all attachments on a ticket, oldest first. */
export function listMetaForTicket(ticketId: string): TicketAttachmentMeta[] {
	const rows = getDb()
		.prepare(
			`SELECT id, ticket_id, filename, mime_type, byte_size, created_at
			   FROM ticket_attachments WHERE ticket_id = ? ORDER BY created_at ASC, id ASC`
		)
		.all(ticketId) as MetaRow[];
	return rows.map(rowToMeta);
}

export function countForTicket(ticketId: string): number {
	const r = getDb()
		.prepare('SELECT COUNT(*) AS n FROM ticket_attachments WHERE ticket_id = ?')
		.get(ticketId) as { n: number };
	return r.n;
}

export interface AttachmentBytes {
	filename: string;
	mimeType: string;
	byteSize: number;
	data: Buffer;
}

/**
 * Fetch an attachment's bytes only if it belongs to `ticketId` AND that ticket
 * belongs to `userId`. Returns null on any mismatch so the endpoint can 404
 * without leaking existence.
 */
export function getForOwner(
	ticketId: string,
	attachmentId: string,
	userId: string
): AttachmentBytes | null {
	const row = getDb()
		.prepare(
			`SELECT ta.filename, ta.mime_type, ta.byte_size, ta.data
			   FROM ticket_attachments ta
			   JOIN workspace_tickets t ON t.id = ta.ticket_id
			  WHERE ta.id = ?
			    AND ta.ticket_id = ?
			    AND t.user_id = ?`
		)
		.get(attachmentId, ticketId, userId) as
		| { filename: string; mime_type: string; byte_size: number; data: Buffer }
		| undefined;
	if (!row) return null;
	return {
		filename: row.filename,
		mimeType: row.mime_type,
		byteSize: row.byte_size,
		data: row.data
	};
}

/**
 * Remove one attachment. Returns true if deleted. Only removes if the owning
 * ticket belongs to `userId`.
 */
export function remove(ticketId: string, attachmentId: string, userId: string): boolean {
	const r = getDb()
		.prepare(
			`DELETE FROM ticket_attachments
			  WHERE id = ?
			    AND ticket_id = ?
			    AND ticket_id IN (SELECT id FROM workspace_tickets WHERE user_id = ?)`
		)
		.run(attachmentId, ticketId, userId);
	return r.changes > 0;
}

// Test helper: count rows for a ticket (used to assert cascade cleanup).
export function _countForTicket(db: Database.Database, ticketId: string): number {
	const r = db
		.prepare('SELECT COUNT(*) AS n FROM ticket_attachments WHERE ticket_id = ?')
		.get(ticketId) as { n: number };
	return r.n;
}
