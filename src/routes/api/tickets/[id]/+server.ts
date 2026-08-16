import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { ticketId } from '$lib/ids';
import * as tickets from '$lib/server/db/repos/tickets';
import { ticketWorkspaceFromInput } from '$lib/server/ticket-workspace';
import { parseBody } from '$lib/server/validate';

const PatchBody = z
	.object({
		title: z.string().trim().min(1).max(200).optional(),
		body: z.string().trim().max(8000).optional(),
		plan: z.string().trim().max(100000).optional(),
		priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
		status: z.enum(['open', 'done', 'archived']).optional(),
		workspace: z.string().min(1).optional()
	})
	.refine(
		(b) =>
			b.title !== undefined ||
			b.body !== undefined ||
			b.plan !== undefined ||
			b.priority !== undefined ||
			b.status !== undefined,
		{
			message: 'No fields to update'
		}
	);

export const GET: RequestHandler = ({ params, locals }) => {
	const userId = locals.userId;
	const ticketIdInt = ticketId.tryParse(params.id);
	if (ticketIdInt === null) throw error(404);
	const ticket = tickets.get(ticketIdInt, userId);
	if (!ticket) throw error(404);
	return json({ ticket });
};

export const PATCH: RequestHandler = async ({ params, locals, request }) => {
	const userId = locals.userId;
	const body = await parseBody(request, PatchBody);
	const ticketIdInt = ticketId.tryParse(params.id);
	if (ticketIdInt === null) throw error(404);
	const current = tickets.get(ticketIdInt, userId);
	if (!current) throw error(404);
	if (body.workspace) {
		const workspace = ticketWorkspaceFromInput(body.workspace, userId);
		if (current.workspaceKey !== workspace) throw error(404);
	}
	const ticket = tickets.update(ticketIdInt, userId, {
		...(body.title !== undefined ? { title: body.title } : {}),
		...(body.body !== undefined ? { body: body.body } : {}),
		...(body.plan !== undefined ? { plan: body.plan } : {}),
		...(body.priority !== undefined ? { priority: body.priority } : {}),
		...(body.status !== undefined ? { status: body.status } : {})
	});
	if (!ticket) throw error(404);
	return json({ ok: true, ticket });
};

export const DELETE: RequestHandler = ({ params, locals, url }) => {
	const userId = locals.userId;
	const ticketIdInt = ticketId.tryParse(params.id);
	if (ticketIdInt === null) throw error(404);
	const current = tickets.get(ticketIdInt, userId);
	if (!current) throw error(404);
	const requestedWorkspace = url.searchParams.get('workspace');
	if (requestedWorkspace) {
		const workspace = ticketWorkspaceFromInput(requestedWorkspace, userId);
		if (current.workspaceKey !== workspace) throw error(404);
	}
	// `?purge=true` permanently removes the ticket row (cascading its dependency
	// edges via FK ON DELETE CASCADE). The default — no flag —
	// keeps the historical soft-delete behavior, archiving the ticket so it can
	// still be reopened.
	if (url.searchParams.get('purge') === 'true') {
		const deleted = tickets.remove(ticketIdInt, userId);
		if (!deleted) throw error(404);
		return json({ ok: true, deleted: true });
	}
	const ticket = tickets.update(ticketIdInt, userId, { status: 'archived' });
	if (!ticket) throw error(404);
	return json({ ok: true, ticket });
};
