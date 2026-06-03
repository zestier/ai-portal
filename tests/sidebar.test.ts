import { describe, it, expect } from 'vitest';
import { archiveWorkspaceTicket } from '../src/lib/client/ticket-archive';
import { resolveInitialSidebarOpen } from '../src/lib/client/sidebar';
import { ticketChatPrompt, ticketChatTitle, ticketDraftChatUrl } from '../src/lib/client/tickets';

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

describe('ticket chat helpers', () => {
	it('uses the ticket title as the chat title', () => {
		expect(ticketChatTitle({ title: 'Fix sidebar actions' })).toBe('Fix sidebar actions');
	});

	it('labels refinement chats by mode', () => {
		expect(ticketChatTitle({ title: 'Fix sidebar actions' }, 'refine')).toBe(
			'Refine ticket: Fix sidebar actions'
		);
	});

	it('builds an actionable initial prompt for a ticket with details', () => {
		expect(
			ticketChatPrompt({
				id: 'ticket-1',
				title: 'Fix sidebar actions',
				body: 'Add a launch button.'
			})
		).toBe(
			'Do this workspace ticket: Fix sidebar actions\n\nTicket ID: ticket-1\n\nAdd a launch button.'
		);
	});

	it('builds a ticket refinement prompt that avoids implementation', () => {
		expect(
			ticketChatPrompt(
				{
					id: 'ticket-1',
					title: 'Fix sidebar actions',
					body: 'Add a launch button.'
				},
				'refine'
			)
		).toBe(
			'Refine this workspace ticket: Fix sidebar actions\n\nClarify the request, acceptance criteria, scope, risks, and useful implementation notes. Research the code if needed. Ask me the questions required to flesh out the ticket, driving each open decision to a concrete choice rather than leaving it ambiguous. Record those decisions in the ticket. Update the ticket instead of implementing it unless explicitly asked.\n\nTicket ID: ticket-1\n\nAdd a launch button.'
		);
	});

	it('omits empty ticket details from the initial prompt', () => {
		expect(ticketChatPrompt({ id: 'ticket-1', title: 'Fix sidebar actions', body: '  ' })).toBe(
			'Do this workspace ticket: Fix sidebar actions\n\nTicket ID: ticket-1'
		);
	});

	it('builds draft chat URLs without embedding ticket details', () => {
		expect(ticketDraftChatUrl('conv-1', 'ticket-1', 'do')).toBe(
			'/conversations/conv-1?draftTicketId=ticket-1&ticketMode=do'
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
