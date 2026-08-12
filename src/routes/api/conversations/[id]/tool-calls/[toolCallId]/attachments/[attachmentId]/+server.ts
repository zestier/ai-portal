import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorizeConversation } from '$lib/server/conversation-auth';
import * as toolAttachments from '$lib/server/db/repos/tool-attachments';

// Serves the raw bytes of a single captured tool attachment (e.g. an image the
// agent viewed). Ownership is enforced in the repo query (attachment → tool
// call → message → conversation owner), so a mismatched user/conversation 404s
// rather than leaking the bytes or the attachment's existence.
export const GET: RequestHandler = async ({ params, locals }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	const toolCallId = Number(params.toolCallId);
	const attachmentId = Number(params.attachmentId);
	if (!params.toolCallId || !params.attachmentId) throw error(400, 'missing id');
	if (
		!Number.isInteger(toolCallId) ||
		toolCallId <= 0 ||
		!Number.isInteger(attachmentId) ||
		attachmentId <= 0
	) {
		throw error(400, 'missing id');
	}

	const att = toolAttachments.getForOwner(conv.id, toolCallId, attachmentId, conv.userId);
	if (!att) throw error(404);

	return new Response(new Uint8Array(att.data), {
		headers: {
			'content-type': att.mimeType,
			'content-length': String(att.byteSize),
			// Attachments are immutable once captured; let the browser cache them
			// privately so re-renders don't re-fetch the bytes.
			'cache-control': 'private, max-age=31536000, immutable',
			'content-disposition': 'inline'
		}
	});
};
