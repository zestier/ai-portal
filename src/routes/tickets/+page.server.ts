import type { PageServerLoad } from './$types';
import * as tickets from '$lib/server/db/repos/tickets';
import { TICKETS_PAGE_SIZE } from '$lib/client/tickets-list';

export const load: PageServerLoad = async ({ locals, parent }) => {
	// Reuse the layout's computed workspace so this page and the sidebar always
	// agree on scope. When there's no current workspace, render an empty list and
	// let the page show a prompt rather than erroring.
	const { ticketWorkspace } = await parent();
	const userId = locals.userId;
	const initial =
		userId && ticketWorkspace
			? tickets.list(userId, ticketWorkspace, {
					status: 'open',
					limit: TICKETS_PAGE_SIZE,
					offset: 0
				})
			: [];
	return {
		ticketWorkspace,
		pageSize: TICKETS_PAGE_SIZE,
		initialStatus: 'open' as const,
		initialTickets: initial,
		initialHasMore: initial.length === TICKETS_PAGE_SIZE
	};
};
