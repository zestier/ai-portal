import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import * as interactive from '$lib/server/runtime/interactive-requests';
import { parseBody } from '$lib/server/validate';
import { authorizeConversation } from '$lib/server/conversation-auth';
import type { InteractiveResponse } from '$lib/types';
import { Body } from '$lib/server/runtime/interactive-resolve-body';

export const POST: RequestHandler = async ({ params, locals, request }) => {
	const conv = authorizeConversation(params.id, locals.userId);

	const body = normalizeResponse((await parseBody(request, Body)) as InteractiveResponse);
	const pending = interactive.get(params.requestId!);
	if (!pending || pending.conversationId !== conv.id) throw error(404);
	if (
		pending.view.kind === 'permission' &&
		pending.view.canPersistDecision === false &&
		body.kind === 'permission' &&
		(body.decision === 'allow-always' || body.decision === 'deny-always')
	) {
		throw error(400, 'persistent decisions are not allowed for this request');
	}

	const ok = interactive.resolve(params.requestId!, conv.userId, body);
	if (!ok) throw error(409, 'kind mismatch or already resolved');
	return json({ ok: true });
};

function normalizeResponse(body: InteractiveResponse): InteractiveResponse {
	if (
		body.kind === 'permission' &&
		body.feedback &&
		body.decision !== 'deny' &&
		body.decision !== 'deny-always'
	) {
		const normalized = { ...body };
		delete normalized.feedback;
		return normalized;
	}
	return body;
}
