type TicketArchiveFetch = (url: string, init: RequestInit) => Promise<Response>;

export async function archiveWorkspaceTicket({
	ticketId,
	workspace,
	fetcher = fetch
}: {
	ticketId: string;
	workspace?: string | null;
	fetcher?: TicketArchiveFetch;
}): Promise<{ ok: true } | { ok: false; status?: number }> {
	const params = new URLSearchParams();
	if (workspace) params.set('workspace', workspace);
	const query = params.toString();
	const res = await fetcher(
		`/api/tickets/${encodeURIComponent(ticketId)}${query ? `?${query}` : ''}`,
		{
			method: 'DELETE'
		}
	);
	if (!res.ok) return { ok: false, status: res.status };
	return { ok: true };
}

/**
 * Permanently delete a workspace ticket via `DELETE /api/tickets/[id]?purge=true`.
 * Unlike {@link archiveWorkspaceTicket} (which soft-archives), this removes the
 * row and its dependency edges / attachments for good — there is no undo. The
 * detail page uses this behind a confirm modal.
 */
export async function deleteWorkspaceTicket({
	ticketId,
	workspace,
	fetcher = fetch
}: {
	ticketId: string;
	workspace?: string | null;
	fetcher?: TicketArchiveFetch;
}): Promise<{ ok: true } | { ok: false; status?: number }> {
	const params = new URLSearchParams({ purge: 'true' });
	if (workspace) params.set('workspace', workspace);
	const res = await fetcher(`/api/tickets/${encodeURIComponent(ticketId)}?${params.toString()}`, {
		method: 'DELETE'
	});
	if (!res.ok) return { ok: false, status: res.status };
	return { ok: true };
}
