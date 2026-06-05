import {
	interpolateTicketPrompt,
	ticketActionChatTitle,
	ticketActionConversationMode,
	ticketActionDraftUrl
} from '$lib/tickets/chat';
import type { ChatPromptTemplate, WorkspaceTicket } from '$lib/types';

type TicketDraftFetch = (url: string, init: RequestInit) => Promise<Response>;

type TicketActionTemplate = Pick<
	ChatPromptTemplate,
	'id' | 'prompt' | 'launchBehavior' | 'conversationMode'
>;

/**
 * Create a draft chat for a ticket-action template with `launchBehavior: 'draft'`.
 * The conversation is created (with any mode override) and the returned URL pre-
 * fills the composer with the interpolated prompt server-side. The interpolated
 * prompt is also computed here so callers/tests can verify it without a round trip.
 */
export async function createTicketDraftChat({
	ticket,
	template,
	workdir,
	fetcher = fetch
}: {
	ticket: WorkspaceTicket;
	template: TicketActionTemplate;
	workdir?: string | null;
	fetcher?: TicketDraftFetch;
}): Promise<{ ok: true; href: string; prompt: string } | { ok: false; status?: number }> {
	const convRes = await fetcher('/api/conversations', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			title: ticketActionChatTitle(ticket),
			workdir: workdir ?? undefined,
			mode: ticketActionConversationMode(template)
		})
	});
	if (!convRes.ok) return { ok: false, status: convRes.status };
	const body = await convRes.json();
	return {
		ok: true,
		href: ticketActionDraftUrl(body.conversation.id, ticket.id, template.id),
		prompt: interpolateTicketPrompt(template, ticket)
	};
}
