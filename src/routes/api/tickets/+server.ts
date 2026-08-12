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
const Sort = z.enum(['recency', 'priority']);
const Priority = z.enum(['P0', 'P1', 'P2', 'P3']);

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
	// Optional priority sort + filter (default: recency, all priorities). Invalid
	// or absent values fall back safely, matching the status/limit/offset style.
	const sort = Sort.catch('recency').parse(url.searchParams.get('sort') ?? 'recency');
	const priority = Priority.optional()
		.catch(undefined)
		.parse(url.searchParams.get('priority') ?? undefined);
	return json({
		tickets: tickets.list(userId, workspace, {
			status,
			limit,
			offset,
			sort,
			...(priority ? { priority } : {})
		}),
		workspace
	});
};

const CreateBody = z.object({
	title: z.string().trim().min(1).max(200),
	body: z.string().trim().max(8000).optional(),
	plan: z.string().trim().max(100000).optional(),
	priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
	workspace: z.string().min(1).optional(),
	sourceConversationId: z.number().int().positive().optional(),
	sourceMessageId: z.number().int().positive().optional()
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
		workspace = ticketWorkspaceFromConversation(conv);
	} else if (body.sourceMessageId) {
		throw error(400, 'sourceConversationId is required when sourceMessageId is set');
	}

	const ticket = tickets.create(userId, {
		workspaceKey: workspace,
		title: body.title,
		sourceConversationId: body.sourceConversationId ?? null,
		sourceMessageId: body.sourceMessageId ?? null,
		...(body.body !== undefined ? { body: body.body } : {}),
		...(body.plan !== undefined ? { plan: body.plan } : {}),
		...(body.priority !== undefined ? { priority: body.priority } : {})
	});
	return json({ ok: true, ticket }, { status: 201 });
};
