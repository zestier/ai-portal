import type { LayoutServerLoad } from './$types';
import * as convs from '$lib/server/db/repos/conversations';
import * as tickets from '$lib/server/db/repos/tickets';
import * as promptTemplates from '$lib/server/db/repos/prompt-templates';
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
	return {
		user: locals.user,
		conversations,
		tickets:
			locals.userId && ticketWorkspace
				? tickets.list(locals.userId, ticketWorkspace, { status: 'open', limit: 10 })
				: [],
		ticketCount:
			locals.userId && ticketWorkspace ? tickets.count(locals.userId, ticketWorkspace) : 0,
		ticketWorkspace,
		ticketActions
	};
};
