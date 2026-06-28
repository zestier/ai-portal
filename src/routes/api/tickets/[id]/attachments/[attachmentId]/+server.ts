import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserId } from '$lib/server/auth/require';
import * as tickets from '$lib/server/db/repos/tickets';
import * as ticketAttachments from '$lib/server/db/repos/ticket-attachments';

export const GET: RequestHandler = ({ params, locals }) => {
	const userId = requireUserId(locals);
	const ticket = tickets.get(params.id, userId);
	if (!ticket) throw error(404);
	const att = ticketAttachments.getForOwner(params.id, params.attachmentId, userId);
	if (!att) throw error(404);
	// Only raster images are safe to render inline from our own origin. Anything
	// else (HTML, SVG, scripts, unknown blobs) is forced to download so a crafted
	// attachment can't execute script in the portal origin. `nosniff` stops the
	// browser from second-guessing the declared type, and the sandbox CSP defangs
	// any document that does get rendered.
	const inlineOk = att.mimeType.startsWith('image/') && att.mimeType !== 'image/svg+xml';
	return new Response(new Uint8Array(att.data), {
		headers: {
			'content-type': att.mimeType,
			'content-length': String(att.byteSize),
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
	const ticket = tickets.get(params.id, userId);
	if (!ticket) throw error(404);
	const removed = ticketAttachments.remove(params.id, params.attachmentId, userId);
	if (!removed) throw error(404);
	return new Response(null, { status: 204 });
};
