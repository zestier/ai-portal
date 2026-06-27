import type { WorkspaceTicket } from '$lib/types';

export type TicketListStatus = 'open' | 'done' | 'archived' | 'all';

/** Page size for the `/tickets` index list and its "Load more" pagination. */
export const TICKETS_PAGE_SIZE = 20;

type TicketsFetch = (url: string) => Promise<Response>;

export interface TicketsPage {
	tickets: WorkspaceTicket[];
	/** True when the returned page filled `limit`, so another page may exist. */
	hasMore: boolean;
}

/**
 * Build the `/api/tickets` query string for a single page of the index list.
 * Kept separate from the fetch so it can be unit-tested without a network stub.
 */
export function ticketsPageUrl({
	status,
	workspace,
	limit,
	offset
}: {
	status: TicketListStatus;
	workspace?: string | null;
	limit: number;
	offset: number;
}): string {
	const params = new URLSearchParams();
	params.set('status', status);
	if (workspace) params.set('workspace', workspace);
	params.set('limit', String(limit));
	params.set('offset', String(offset));
	return `/api/tickets?${params.toString()}`;
}

/**
 * Fetch one page of tickets for the index page. `hasMore` is inferred from a
 * full page (`tickets.length === limit`): a naive offset signal that's good
 * enough for this low-stakes, updated-desc list.
 */
export async function fetchTicketsPage({
	status,
	workspace,
	limit,
	offset,
	fetcher = fetch
}: {
	status: TicketListStatus;
	workspace?: string | null;
	limit: number;
	offset: number;
	fetcher?: TicketsFetch;
}): Promise<TicketsPage> {
	const res = await fetcher(ticketsPageUrl({ status, workspace, limit, offset }));
	if (!res.ok) throw new Error(`Failed to load tickets (${res.status})`);
	const data = (await res.json()) as { tickets: WorkspaceTicket[] };
	const tickets = data.tickets ?? [];
	return { tickets, hasMore: tickets.length === limit };
}
