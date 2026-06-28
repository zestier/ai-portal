import {
	interpolatePrompt,
	ticketPlaceholderValues,
	type PromptTemplateListItem
} from '$lib/prompt-templates';
import type { ChatPromptTemplate, SessionMode, WorkspaceTicket } from '$lib/types';

/**
 * Conversation title for a ticket-action chat. Data-driven actions keep the
 * ticket's own title as the conversation name; the action label lives on the
 * button, not the chat title.
 */
export function ticketActionChatTitle(ticket: Pick<WorkspaceTicket, 'title'>): string {
	return ticket.title;
}

/**
 * Conversation-mode override for a ticket-action template, or `undefined` to use
 * the user's default mode (e.g. the seeded "Refine" action forces `interactive`).
 */
export function ticketActionConversationMode(
	template: Pick<ChatPromptTemplate, 'conversationMode'>
): SessionMode | undefined {
	return template.conversationMode ?? undefined;
}

/**
 * Model override for a ticket-action template, or `undefined` to use the user's
 * default model. A stale id is passed through unchanged; the conversation API
 * stores whatever it's given.
 */
export function ticketActionModel(template: Pick<ChatPromptTemplate, 'model'>): string | undefined {
	return template.model ?? undefined;
}

/** Interpolate a ticket-action template's prompt with a ticket's values. */
export function interpolateTicketPrompt(
	template: Pick<ChatPromptTemplate, 'prompt'>,
	ticket: Pick<WorkspaceTicket, 'id' | 'title' | 'body' | 'plan'>
): string {
	return interpolatePrompt(template.prompt, ticketPlaceholderValues(ticket));
}

/**
 * Draft URL for a ticket-action launch. The conversation load resolves the
 * ticket + action template server-side and pre-fills the interpolated prompt.
 */
export function ticketActionDraftUrl(
	conversationId: string,
	ticketId: string,
	actionId: string
): string {
	const params = new URLSearchParams({
		draftTicketId: ticketId,
		ticketActionId: actionId
	});
	return `/conversations/${encodeURIComponent(conversationId)}?${params.toString()}`;
}

export type TicketActionListItem = PromptTemplateListItem;
