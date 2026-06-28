import {
	interpolateTicketPrompt,
	ticketActionChatTitle,
	ticketActionConversationMode,
	ticketActionModel,
	ticketActionDraftUrl
} from '$lib/tickets/chat';
import type { ChatPromptTemplate, WorkspaceTicket } from '$lib/types';

type TicketDraftFetch = (url: string, init: RequestInit) => Promise<Response>;

type TicketActionTemplate = Pick<
	ChatPromptTemplate,
	'id' | 'prompt' | 'launchBehavior' | 'conversationMode' | 'model'
>;

/**
 * Immediate-launch path for a ticket-action template (`launchBehavior: 'send'`):
 * create a conversation, post the interpolated prompt as the first turn, and
 * return the conversation href for the caller to navigate to. On a failed turn
 * (or a thrown request) the just-created conversation is deleted so a launch
 * failure never leaves an empty orphan chat behind.
 *
 * Navigation and busy/error UI stay with the caller; the `stage` on a failure
 * lets each surface produce its own message (create vs. launch).
 */
export async function createTicketLaunchChat({
	ticket,
	template,
	workdir,
	fetcher = fetch
}: {
	ticket: WorkspaceTicket;
	template: TicketActionTemplate;
	workdir?: string | null;
	fetcher?: TicketDraftFetch;
}): Promise<
	| { ok: true; conversationId: string; href: string }
	| { ok: false; stage: 'create' | 'launch'; status?: number }
> {
	let conversationId: string | null = null;
	try {
		const convRes = await fetcher('/api/conversations', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				title: ticketActionChatTitle(ticket),
				workdir: workdir ?? undefined,
				mode: ticketActionConversationMode(template),
				model: ticketActionModel(template)
			})
		});
		if (!convRes.ok) return { ok: false, stage: 'create', status: convRes.status };
		const body = await convRes.json();
		conversationId = body.conversation.id as string;
		const turnRes = await fetcher(`/api/conversations/${conversationId}/turns`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ content: interpolateTicketPrompt(template, ticket) })
		});
		if (!turnRes.ok) {
			await deleteConversation(fetcher, conversationId);
			return { ok: false, stage: 'launch', status: turnRes.status };
		}
		return { ok: true, conversationId, href: `/conversations/${conversationId}` };
	} catch (err) {
		if (conversationId) await deleteConversation(fetcher, conversationId);
		throw err;
	}
}

async function deleteConversation(
	fetcher: TicketDraftFetch,
	conversationId: string
): Promise<void> {
	try {
		await fetcher(`/api/conversations/${conversationId}`, { method: 'DELETE' });
	} catch {
		// Best-effort cleanup; surfacing this error would mask the original failure.
	}
}

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
			mode: ticketActionConversationMode(template),
			model: ticketActionModel(template)
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
