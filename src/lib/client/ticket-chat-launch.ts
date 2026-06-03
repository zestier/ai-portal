import {
	ticketChatConversationMode,
	ticketChatTitle,
	ticketDraftChatUrl,
	type TicketChatMode
} from '$lib/tickets/chat';
import type { WorkspaceTicket } from '$lib/types';

type TicketDraftFetch = (url: string, init: RequestInit) => Promise<Response>;

export async function createTicketDraftChat({
	ticket,
	mode,
	workdir,
	fetcher = fetch
}: {
	ticket: WorkspaceTicket;
	mode: TicketChatMode;
	workdir?: string | null;
	fetcher?: TicketDraftFetch;
}): Promise<{ ok: true; href: string } | { ok: false; status?: number }> {
	const convRes = await fetcher('/api/conversations', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			title: ticketChatTitle(ticket, mode),
			workdir: workdir ?? undefined,
			mode: ticketChatConversationMode(mode)
		})
	});
	if (!convRes.ok) return { ok: false, status: convRes.status };
	const body = await convRes.json();
	return { ok: true, href: ticketDraftChatUrl(body.conversation.id, ticket.id, mode) };
}
