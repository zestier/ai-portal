import { describe, it, expect } from 'vitest';
import { archiveWorkspaceTicket } from '../src/lib/client/ticket-archive';
import { resolveInitialSidebarOpen, orderSidebarTickets } from '../src/lib/client/sidebar';
import { isAwaitingInput } from '../src/lib/client/awaiting-input';
import {
	interpolateTicketPrompt,
	ticketActionChatTitle,
	ticketActionConversationMode,
	ticketActionDraftUrl
} from '../src/lib/client/tickets';

describe('resolveInitialSidebarOpen', () => {
	it('honors a persisted "true" value regardless of viewport', () => {
		expect(resolveInitialSidebarOpen({ getStored: () => 'true', isDesktop: () => false })).toBe(
			true
		);
	});

	it('honors a persisted "false" value regardless of viewport', () => {
		expect(resolveInitialSidebarOpen({ getStored: () => 'false', isDesktop: () => true })).toBe(
			false
		);
	});

	it('defaults to open on desktop when nothing is persisted', () => {
		expect(resolveInitialSidebarOpen({ getStored: () => null, isDesktop: () => true })).toBe(true);
	});

	it('defaults to closed on mobile when nothing is persisted', () => {
		expect(resolveInitialSidebarOpen({ getStored: () => null, isDesktop: () => false })).toBe(
			false
		);
	});

	it('treats unrecognized stored values as missing', () => {
		expect(resolveInitialSidebarOpen({ getStored: () => 'garbage', isDesktop: () => false })).toBe(
			false
		);
		expect(resolveInitialSidebarOpen({ getStored: () => '', isDesktop: () => true })).toBe(true);
	});
});

describe('isAwaitingInput', () => {
	it('falls back to the server set when there is no live override', () => {
		const server = new Set(['a', 'b']);
		expect(isAwaitingInput('a', server, {})).toBe(true);
		expect(isAwaitingInput('c', server, {})).toBe(false);
	});

	it('lets a live override win over the server set in both directions', () => {
		const server = new Set(['a']);
		// Override clears an indicator the server still reports (open conv just resolved).
		expect(isAwaitingInput('a', server, { a: false })).toBe(false);
		// Override raises an indicator the server has not caught up on yet.
		expect(isAwaitingInput('b', server, { b: true })).toBe(true);
	});

	it('treats only own-key overrides as authoritative', () => {
		const server = new Set<string>();
		expect(isAwaitingInput('a', server, { b: true })).toBe(false);
	});
});

describe('orderSidebarTickets', () => {
	const t = (id: string, blockerIds: string[] = []) => ({
		id,
		blockers: blockerIds.map((bid) => ({ id: bid, title: bid, status: 'open' as const }))
	});

	it('sorts ready (unblocked) tickets ahead of blocked ones', () => {
		const ordered = orderSidebarTickets([t('a', ['x']), t('b'), t('c', ['y']), t('d')]);
		expect(ordered.map((o) => o.id)).toEqual(['b', 'd', 'a', 'c']);
	});

	it('preserves the incoming order within each group (stable partition)', () => {
		const ordered = orderSidebarTickets([
			t('a'),
			t('b', ['x']),
			t('c'),
			t('d', ['y']),
			t('e', ['z'])
		]);
		expect(ordered.map((o) => o.id)).toEqual(['a', 'c', 'b', 'd', 'e']);
	});

	it('returns tickets unchanged when none are blocked', () => {
		const ordered = orderSidebarTickets([t('a'), t('b'), t('c')]);
		expect(ordered.map((o) => o.id)).toEqual(['a', 'b', 'c']);
	});

	it('does not mutate the input array', () => {
		const input = [t('a', ['x']), t('b')];
		const snapshot = input.map((o) => o.id);
		orderSidebarTickets(input);
		expect(input.map((o) => o.id)).toEqual(snapshot);
	});
});

describe('ticket action helpers', () => {
	const doPrompt =
		'Do this workspace ticket: {{ticket.title}}\n\nTicket ID: {{ticket.id}}\n\n{{ticket.body}}';
	const refinePrompt =
		'Refine this workspace ticket: {{ticket.title}}\n\nClarify the request, acceptance criteria, scope, risks, and useful implementation notes. Research the code if needed. Ask me the questions required to flesh out the ticket, driving each open decision to a concrete choice rather than leaving it ambiguous. Record those decisions in the ticket. Update the ticket instead of implementing it unless explicitly asked.\n\nTicket ID: {{ticket.id}}\n\n{{ticket.body}}';

	it('uses the ticket title as the chat title', () => {
		expect(ticketActionChatTitle({ title: 'Fix sidebar actions' })).toBe('Fix sidebar actions');
	});

	it('returns the action conversation-mode override or undefined for default', () => {
		expect(ticketActionConversationMode({ conversationMode: 'interactive' })).toBe('interactive');
		expect(ticketActionConversationMode({ conversationMode: null })).toBeUndefined();
	});

	it('interpolates a ticket-action prompt with ticket details', () => {
		expect(
			interpolateTicketPrompt(
				{ prompt: doPrompt },
				{ id: 'ticket-1', title: 'Fix sidebar actions', body: 'Add a launch button.', plan: '' }
			)
		).toBe(
			'Do this workspace ticket: Fix sidebar actions\n\nTicket ID: ticket-1\n\nAdd a launch button.'
		);
	});

	it('interpolates the refine prompt that avoids implementation', () => {
		expect(
			interpolateTicketPrompt(
				{ prompt: refinePrompt },
				{ id: 'ticket-1', title: 'Fix sidebar actions', body: 'Add a launch button.', plan: '' }
			)
		).toBe(
			'Refine this workspace ticket: Fix sidebar actions\n\nClarify the request, acceptance criteria, scope, risks, and useful implementation notes. Research the code if needed. Ask me the questions required to flesh out the ticket, driving each open decision to a concrete choice rather than leaving it ambiguous. Record those decisions in the ticket. Update the ticket instead of implementing it unless explicitly asked.\n\nTicket ID: ticket-1\n\nAdd a launch button.'
		);
	});

	it('trims dangling blank lines when the ticket body is empty', () => {
		expect(
			interpolateTicketPrompt(
				{ prompt: doPrompt },
				{ id: 'ticket-1', title: 'Fix sidebar actions', body: '  ', plan: '' }
			)
		).toBe('Do this workspace ticket: Fix sidebar actions\n\nTicket ID: ticket-1');
	});

	it('builds encoded draft chat URLs that carry the action id', () => {
		expect(ticketActionDraftUrl('conv-1', 'ticket-1', 'action-1')).toBe(
			'/conversations/conv-1?draftTicketId=ticket-1&ticketActionId=action-1'
		);
	});
});

describe('ticket archive helper', () => {
	it('archives a ticket with workspace scoping', async () => {
		const calls: Array<[string, RequestInit]> = [];
		const result = await archiveWorkspaceTicket({
			ticketId: 'ticket/1',
			workspace: '/workspace with spaces',
			fetcher: async (url, init) => {
				calls.push([url, init]);
				return Response.json({ ok: true });
			}
		});

		expect(result).toEqual({ ok: true });
		expect(calls).toEqual([
			[
				'/api/tickets/ticket%2F1?workspace=%2Fworkspace+with+spaces',
				{
					method: 'DELETE'
				}
			]
		]);
	});

	it('returns the failed archive status', async () => {
		const result = await archiveWorkspaceTicket({
			ticketId: 'ticket-1',
			fetcher: async () => new Response(null, { status: 404 })
		});

		expect(result).toEqual({ ok: false, status: 404 });
	});
});
