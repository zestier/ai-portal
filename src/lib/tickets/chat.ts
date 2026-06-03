import type { SessionMode, WorkspaceTicket } from '$lib/types';

export type TicketChatMode = 'do' | 'refine';

/**
 * Refine chats are exploratory by nature — they research and update the ticket
 * rather than implement it — so they always run interactively regardless of the
 * user's default conversation mode.
 */
export function ticketChatConversationMode(mode: TicketChatMode): SessionMode | undefined {
	return mode === 'refine' ? 'interactive' : undefined;
}

export function ticketChatTitle(
	ticket: Pick<WorkspaceTicket, 'title'>,
	mode: TicketChatMode = 'do'
): string {
	if (mode === 'refine') return `Refine ticket: ${ticket.title}`;
	return ticket.title;
}

export function ticketChatPrompt(
	ticket: Pick<WorkspaceTicket, 'id' | 'title' | 'body'>,
	mode: TicketChatMode = 'do'
): string {
	const header =
		mode === 'refine'
			? `Refine this workspace ticket: ${ticket.title}`
			: `Do this workspace ticket: ${ticket.title}`;
	const instructions =
		mode === 'refine'
			? 'Clarify the request, acceptance criteria, scope, risks, and useful implementation notes. Research the code if needed. Ask me the questions required to flesh out the ticket, driving each open decision to a concrete choice rather than leaving it ambiguous. Record those decisions in the ticket. Update the ticket instead of implementing it unless explicitly asked.'
			: null;
	const lines = [header, ''];
	if (instructions) lines.push(instructions, '');
	lines.push(`Ticket ID: ${ticket.id}`);
	const body = ticket.body.trim();
	if (body) lines.push('', body);
	return lines.join('\n');
}

export function isTicketChatMode(value: string | null): value is TicketChatMode {
	return value === 'do' || value === 'refine';
}

export function ticketDraftChatUrl(
	conversationId: string,
	ticketId: string,
	mode: TicketChatMode
): string {
	const params = new URLSearchParams({
		draftTicketId: ticketId,
		ticketMode: mode
	});
	return `/conversations/${conversationId}?${params.toString()}`;
}
