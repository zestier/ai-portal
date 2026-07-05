import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import * as tickets from '$lib/server/db/repos/tickets';
import * as ticketAttachments from '$lib/server/db/repos/ticket-attachments';
import { ticketWorkspaceFromInput } from '$lib/server/ticket-workspace';
import { parseBody } from '$lib/server/validate';
import { requireUserId } from '$lib/server/auth/require';

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
	const userId = requireUserId(locals);
	const ticket = tickets.get(params.id, userId);
	if (!ticket) throw error(404);
	const attachments = ticketAttachments.listMetaForTicket(params.id);
	return json({ ticket, attachments });
};

export const PATCH: RequestHandler = async ({ params, locals, request }) => {
	const userId = requireUserId(locals);
	const body = await parseBody(request, PatchBody);
	const current = tickets.get(params.id, userId);
	if (!current) throw error(404);
	if (body.workspace) {
		const workspace = ticketWorkspaceFromInput(body.workspace, userId);
		if (current.workspaceKey !== workspace) throw error(404);
	}
	const ticket = tickets.update(params.id, userId, {
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
	const userId = requireUserId(locals);
	const current = tickets.get(params.id, userId);
	if (!current) throw error(404);
	const requestedWorkspace = url.searchParams.get('workspace');
	if (requestedWorkspace) {
		const workspace = ticketWorkspaceFromInput(requestedWorkspace, userId);
		if (current.workspaceKey !== workspace) throw error(404);
	}
	// `?purge=true` permanently removes the ticket row (cascading its dependency
	// edges and attachments via FK ON DELETE CASCADE). The default — no flag —
	// keeps the historical soft-delete behavior, archiving the ticket so it can
	// still be reopened.
	if (url.searchParams.get('purge') === 'true') {
		const deleted = tickets.remove(params.id, userId);
		if (!deleted) throw error(404);
		return json({ ok: true, deleted: true });
	}
	const ticket = tickets.update(params.id, userId, { status: 'archived' });
	if (!ticket) throw error(404);
	return json({ ok: true, ticket });
};
