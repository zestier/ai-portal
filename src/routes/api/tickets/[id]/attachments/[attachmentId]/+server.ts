import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserId } from '$lib/server/auth/require';
import * as tickets from '$lib/server/db/repos/tickets';
import * as ticketAttachments from '$lib/server/db/repos/ticket-attachments';
import { sanitizeSvg } from '$lib/server/svg-sanitize';

export const GET: RequestHandler = ({ params, locals }) => {
	const userId = requireUserId(locals);
	const ticketId = Number(params.id);
	const attachmentId = Number(params.attachmentId);
	if (!Number.isInteger(ticketId) || ticketId <= 0) throw error(404);
	if (!Number.isInteger(attachmentId) || attachmentId <= 0) throw error(404);
	const ticket = tickets.get(ticketId, userId);
	if (!ticket) throw error(404);
	const att = ticketAttachments.getForOwner(ticketId, attachmentId, userId);
	if (!att) throw error(404);
	// Raster images and SVG are safe to render inline from our origin: SVG is
	// sanitized at upload and re-sanitized here (so legacy rows stored before
	// sanitization existed are also clean), and the sandbox CSP + nosniff defang
	// any document that does render. Other types (HTML, scripts, unknown blobs)
	// are forced to download so a crafted attachment can't execute in the portal.
	let body = att.data;
	if (att.mimeType === 'image/svg+xml') {
		const clean = sanitizeSvg(att.data);
		if (clean === null) throw error(415, 'SVG could not be sanitized for safe rendering.');
		body = Buffer.from(clean, 'utf-8');
	}
	const inlineOk = att.mimeType.startsWith('image/');
	return new Response(new Uint8Array(body), {
		headers: {
			'content-type': att.mimeType,
			'content-length': String(body.length),
			'cache-control': 'private, max-age=31536000, immutable',
			'x-content-type-options': 'nosniff',
			'content-security-policy': "default-src 'none'; sandbox",
			'content-disposition': contentDisposition(inlineOk ? 'inline' : 'attachment', att.filename)
		}
	});
};

// Build a Content-Disposition header with an RFC 5987-encoded filename so a name
// containing quotes, control chars, or non-ASCII can't break out of the header.
function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
	const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
	const encoded = encodeURIComponent(filename);
	return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export const DELETE: RequestHandler = ({ params, locals }) => {
	const userId = requireUserId(locals);
	const ticketId = Number(params.id);
	const attachmentId = Number(params.attachmentId);
	if (!Number.isInteger(ticketId) || ticketId <= 0) throw error(404);
	if (!Number.isInteger(attachmentId) || attachmentId <= 0) throw error(404);
	const ticket = tickets.get(ticketId, userId);
	if (!ticket) throw error(404);
	const removed = ticketAttachments.remove(ticketId, attachmentId, userId);
	if (!removed) throw error(404);
	return new Response(null, { status: 204 });
};
