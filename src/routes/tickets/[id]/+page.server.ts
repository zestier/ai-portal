import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import * as tickets from '$lib/server/db/repos/tickets';
import * as ticketAttachments from '$lib/server/db/repos/ticket-attachments';
import * as promptTemplates from '$lib/server/db/repos/prompt-templates';
import { requireUserId } from '$lib/server/auth/require';

export const load: PageServerLoad = ({ params, locals }) => {
	const userId = requireUserId(locals);
	const ticketId = Number(params.id);
	if (!Number.isInteger(ticketId) || ticketId <= 0) throw error(404, 'Ticket not found');
	const ticket = tickets.get(ticketId, userId);
	if (!ticket) throw error(404, 'Ticket not found');
	// Match the layout's sidebar sourcing so the detail page's chat-launch buttons
	// offer the same ticket-action templates (lazy-seeding defaults the first time).
	promptTemplates.ensureTicketActionDefaults(userId);
	return {
		ticket,
		// Full dependency picture for the detail view: prerequisites this ticket
		// depends on (with their status, so satisfied ones are distinguishable from
		// active blockers) and the tickets that depend on it.
		dependsOn: tickets.dependencyRefs(ticket.id, userId),
		dependents: tickets.dependentRefs(ticket.id, userId),
		ticketActions: promptTemplates.list(userId, { type: 'ticket-action', status: 'open' }),
		attachments: ticketAttachments.listMetaForTicket(ticketId)
	};
};
