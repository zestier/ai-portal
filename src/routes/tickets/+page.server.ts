import type { PageServerLoad } from './$types';
import * as tickets from '$lib/server/db/repos/tickets';
import { TICKETS_PAGE_SIZE, type TicketListSort } from '$lib/client/tickets-list';
import type { WorkspaceTicketPriority } from '$lib/types';

function parseSort(raw: string | null | undefined): TicketListSort {
	return raw === 'priority' ? 'priority' : 'recency';
}

function parsePriority(raw: string | null | undefined): WorkspaceTicketPriority | undefined {
	return raw === 'P0' || raw === 'P1' || raw === 'P2' || raw === 'P3' ? raw : undefined;
}

export const load: PageServerLoad = async ({ locals, parent, url }) => {
	// Reuse the layout's computed workspace so this page and the sidebar always
	// agree on scope. When there's no current workspace, render an empty list and
	// let the page show a prompt rather than erroring.
	const { ticketWorkspace } = await parent();
	const userId = locals.userId;
	// Read the sort/filter from the URL so a shared/reloaded link renders the
	// correct ordering on first server paint (no client-side reshuffle). `url` is
	// always present at runtime; guard it for unit tests that omit it.
	const params = url?.searchParams;
	const sort = parseSort(params?.get('sort'));
	const priority = parsePriority(params?.get('priority'));
	const initial =
		userId && ticketWorkspace
			? tickets.list(userId, ticketWorkspace, {
					status: 'open',
					limit: TICKETS_PAGE_SIZE,
					offset: 0,
					sort,
					...(priority ? { priority } : {})
				})
			: [];
	return {
		ticketWorkspace,
		pageSize: TICKETS_PAGE_SIZE,
		initialStatus: 'open' as const,
		initialSort: sort,
		initialPriority: (priority ?? 'all') as WorkspaceTicketPriority | 'all',
		initialTickets: initial,
		initialHasMore: initial.length === TICKETS_PAGE_SIZE
	};
};
