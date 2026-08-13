import type { WorkspaceTicketPriority, WorkspaceTicketStatus } from '$lib/types';

type TicketStatusFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Patch a ticket's status via `PATCH /api/tickets/[id]`. Used by the detail-page
 * action toolbar for all status transitions (done/reopen/archive) so the page can
 * stay generic across them and refresh loader data in place afterward.
 */
export async function patchTicketStatus({
	ticketId,
	status,
	fetcher = fetch
}: {
	ticketId: string;
	status: WorkspaceTicketStatus;
	fetcher?: TicketStatusFetch;
}): Promise<{ ok: true } | { ok: false; status?: number }> {
	const res = await fetcher(`/api/tickets/${encodeURIComponent(ticketId)}`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ status })
	});
	if (!res.ok) return { ok: false, status: res.status };
	return { ok: true };
}

/**
 * Patch a ticket's priority via `PATCH /api/tickets/[id]`. Used by the detail
 * page's priority selector so the page can refresh loader data in place after a
 * re-prioritization, mirroring `patchTicketStatus`.
 */
export async function patchTicketPriority({
	ticketId,
	priority,
	fetcher = fetch
}: {
	ticketId: string;
	priority: WorkspaceTicketPriority;
	fetcher?: TicketStatusFetch;
}): Promise<{ ok: true } | { ok: false; status?: number }> {
	const res = await fetcher(`/api/tickets/${encodeURIComponent(ticketId)}`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ priority })
	});
	if (!res.ok) return { ok: false, status: res.status };
	return { ok: true };
}
