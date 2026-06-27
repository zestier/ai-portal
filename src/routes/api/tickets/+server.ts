import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import * as convs from '$lib/server/db/repos/conversations';
import * as messages from '$lib/server/db/repos/messages';
import * as tickets from '$lib/server/db/repos/tickets';
import {
	ticketWorkspaceFromConversation,
	ticketWorkspaceFromInput
} from '$lib/server/ticket-workspace';
import { parseBody } from '$lib/server/validate';
import { requireUserId } from '$lib/server/auth/require';

const Status = z.enum(['open', 'done', 'archived', 'all']);

export const GET: RequestHandler = ({ locals, url }) => {
	const userId = requireUserId(locals);
	const workspace = ticketWorkspaceFromInput(
		url.searchParams.get('workspace') ?? undefined,
		userId
	);
	const status = Status.catch('open').parse(url.searchParams.get('status') ?? 'open');
	const limit = z.coerce
		.number()
		.int()
		.min(1)
		.max(200)
		.catch(100)
		.parse(url.searchParams.get('limit'));
	const offset = z.coerce.number().int().min(0).catch(0).parse(url.searchParams.get('offset'));
	return json({
		tickets: tickets.list(userId, workspace, { status, limit, offset }),
		workspace
	});
};

const CreateBody = z.object({
	title: z.string().trim().min(1).max(200),
	body: z.string().trim().max(8000).optional(),
	plan: z.string().trim().max(100000).optional(),
	workspace: z.string().min(1).optional(),
	sourceConversationId: z.string().min(1).optional(),
	sourceMessageId: z.string().min(1).optional()
});

export const POST: RequestHandler = async ({ locals, request }) => {
	const userId = requireUserId(locals);
	const body = await parseBody(request, CreateBody);
	let workspace = ticketWorkspaceFromInput(body.workspace, userId);

	if (body.sourceConversationId) {
		const conv = convs.get(body.sourceConversationId, userId);
		if (!conv) throw error(404, 'source conversation not found');
		if (
			body.sourceMessageId &&
			!messages.listByConversation(conv.id).some((message) => message.id === body.sourceMessageId)
		) {
			throw error(404, 'source message not found');
		}
		workspace = ticketWorkspaceFromConversation(conv.workdir);
	} else if (body.sourceMessageId) {
		throw error(400, 'sourceConversationId is required when sourceMessageId is set');
	}

	const ticket = tickets.create(userId, {
		workspaceKey: workspace,
		title: body.title,
		body: body.body,
		plan: body.plan,
		sourceConversationId: body.sourceConversationId ?? null,
		sourceMessageId: body.sourceMessageId ?? null
	});
	return json({ ok: true, ticket }, { status: 201 });
};
