import type { LayoutServerLoad } from './$types';
import * as convs from '$lib/server/db/repos/conversations';
import * as tickets from '$lib/server/db/repos/tickets';
import * as promptTemplates from '$lib/server/db/repos/prompt-templates';
import { orderSidebarTickets } from '$lib/client/sidebar';
import type { SidebarTicket } from '$lib/types';
import {
	defaultTicketWorkspace,
	ticketWorkspaceFromConversation
} from '$lib/server/ticket-workspace';

export const load: LayoutServerLoad = ({ locals, params }) => {
	const conversations = locals.userId ? convs.list(locals.userId, { includeArchived: true }) : [];
	let ticketWorkspace: string | null = null;
	if (locals.userId) {
		const activeConversation =
			typeof params.id === 'string' ? convs.get(params.id, locals.userId) : null;
		ticketWorkspace = activeConversation
			? ticketWorkspaceFromConversation(activeConversation.workdir)
			: defaultTicketWorkspace(locals.userId);
	}
	let ticketActions: ReturnType<typeof promptTemplates.list> = [];
	if (locals.userId) {
		// Lazy-seed Do/Draft/Refine the first time the user has no ticket actions
		// so the sidebar always renders sensible defaults out of the box.
		promptTemplates.ensureTicketActionDefaults(locals.userId);
		ticketActions = promptTemplates.list(locals.userId, { type: 'ticket-action', status: 'open' });
	}
	// Enrich the fetched window with each ticket's still-open prerequisites so the
	// sidebar can flag blocked tickets (and tooltip their blocker titles) without
	// a second round-trip, then order ready-before-blocked within the window.
	const userId = locals.userId;
	let sidebarTickets: SidebarTicket[] = [];
	if (userId && ticketWorkspace) {
		sidebarTickets = tickets
			.list(userId, ticketWorkspace, { status: 'open', limit: 10 })
			.map((ticket) => ({
				...ticket,
				blockers: tickets.dependencyRefs(ticket.id, userId).filter((ref) => ref.status === 'open')
			}));
		sidebarTickets = orderSidebarTickets(sidebarTickets);
	}
	return {
		user: locals.user,
		conversations,
		tickets: sidebarTickets,
		ticketCount:
			locals.userId && ticketWorkspace ? tickets.count(locals.userId, ticketWorkspace) : 0,
		ticketWorkspace,
		ticketActions
	};
};
