import { describe, it, expect } from 'vitest';
import { archiveWorkspaceTicket } from '../../src/lib/client/ticket-archive';
import { fetchTicketsPage, ticketsPageUrl } from '../../src/lib/client/tickets-list';
import { resolveInitialSidebarOpen, orderSidebarTickets } from '../../src/lib/client/sidebar';
import { isAwaitingInput } from '../../src/lib/client/awaiting-input';
import {
	interpolateTicketPrompt,
	ticketActionChatTitle,
	ticketActionConversationMode,
	ticketActionDraftUrl
} from '../../src/lib/client/tickets';

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
		const server = new Set(['C1', 'C2']);
		expect(isAwaitingInput('C1', server, {})).toBe(true);
		expect(isAwaitingInput('C3', server, {})).toBe(false);
	});

	it('lets a live override win over the server set in both directions', () => {
		const server = new Set(['C1']);
		// Override clears an indicator the server still reports (open conv just resolved).
		expect(isAwaitingInput('C1', server, { C1: false })).toBe(false);
		// Override raises an indicator the server has not caught up on yet.
		expect(isAwaitingInput('C2', server, { C2: true })).toBe(true);
	});

	it('treats only own-key overrides as authoritative', () => {
		const server = new Set<string>();
		expect(isAwaitingInput('C1', server, { C2: true })).toBe(false);
	});
});

describe('orderSidebarTickets', () => {
	const t = (
		id: number,
		blockerIds: number[] = [],
		priority: 'P0' | 'P1' | 'P2' | 'P3' = 'P2'
	) => ({
		id: `T${id}`,
		priority,
		blockers: blockerIds.map((bid) => ({
			id: `T${bid}`,
			title: String(bid),
			status: 'open' as const
		}))
	});

	it('sorts ready (unblocked) tickets ahead of blocked ones', () => {
		const ordered = orderSidebarTickets([t(1, [10]), t(2), t(3, [11]), t(4)]);
		expect(ordered.map((o) => o.id)).toEqual(['T2', 'T4', 'T1', 'T3']);
	});

	it('preserves the incoming order within each group (stable partition)', () => {
		const ordered = orderSidebarTickets([t(1), t(2, [10]), t(3), t(4, [11]), t(5, [12])]);
		expect(ordered.map((o) => o.id)).toEqual(['T1', 'T3', 'T2', 'T4', 'T5']);
	});

	it('returns tickets unchanged when none are blocked', () => {
		const ordered = orderSidebarTickets([t(1), t(2), t(3)]);
		expect(ordered.map((o) => o.id)).toEqual(['T1', 'T2', 'T3']);
	});

	it('does not mutate the input array', () => {
		const input = [t(1, [10]), t(2)];
		const snapshot = input.map((o) => o.id);
		orderSidebarTickets(input);
		expect(input.map((o) => o.id)).toEqual(snapshot);
	});

	it('orders by priority within each group but keeps ready before blocked', () => {
		// A blocked P0 must still sort after every ready ticket (ready-before-blocked
		// dominates), while priority orders within each group (P0 ahead of P3).
		const ordered = orderSidebarTickets([
			t(1, [], 'P3'),
			t(2, [10], 'P0'),
			t(3, [], 'P0'),
			t(4, [11], 'P3')
		]);
		expect(ordered.map((o) => o.id)).toEqual(['T3', 'T1', 'T2', 'T4']);
	});

	it('keeps recency order within a shared priority (stable sort)', () => {
		const ordered = orderSidebarTickets([t(1, [], 'P2'), t(2, [], 'P2'), t(3, [], 'P1')]);
		expect(ordered.map((o) => o.id)).toEqual(['T3', 'T1', 'T2']);
	});
});

describe('ticket action helpers', () => {
	const doPrompt =
		'Do this workspace ticket: {{ticket.title}}\n\nExecute the spec and plan below. When the plan is detailed, follow it as written — make the changes each step describes, verify each step as it specifies, and do not redesign it. If something is genuinely missing or impossible, stop and ask rather than improvising.\n\nTicket ID: {{ticket.id}}\n\n{{ticket.body}}\n\nPlan:\n{{ticket.plan}}';
	const refinePrompt =
		'Refine this workspace ticket: {{ticket.title}}\n\nTurn this ticket into a complete, self-contained spec and implementation plan that a later "Do" run can execute without making any decisions. You are the strong model doing the thinking up front; the executor that follows may be much weaker, so resolve everything now and leave nothing to infer.\n\nWrite both artifacts into the ticket with `ticket_update` (id {{ticket.id}}), keeping any important details from the current body:\n\n1. Spec (ticket body) — goal, verifiable acceptance criteria, requirements and edge cases, explicit in/out of scope, constraints, and every decision with its rationale. No open questions left.\n\n2. Plan (ticket plan) — an ordered, dependency-sorted checklist of small, independently verifiable steps: file paths, symbols, the exact change, and how to verify each. The executor should only follow it, not design it.\n\nResearch the code first so file paths and approaches are accurate. Ask me the questions needed to drive each open decision to a concrete choice. Do not implement anything — refine only writes the spec and plan.\n\nWrite both artifacts tight:\n- Bullets and fragments, not full-sentence prose. No filler; never restate the ticket title or ID.\n- Include a section only if it carries new information; skip or merge ones that don\'t apply.\n- One line per decision; give rationale only when the choice is non-obvious — one sentence of rationale is a paragraph.\n- Every path, symbol, and verification step stays exact; terse wording never cuts content.\n- Match depth to the ticket: small change → tight spec and short checklist, not a padded one.\n\nTicket ID: {{ticket.id}}\n\n{{ticket.body}}\n\nPlan:\n{{ticket.plan}}';

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
				{ id: 'T1', title: 'Fix sidebar actions', body: 'Add a launch button.', plan: '' }
			)
		).toBe(
			'Do this workspace ticket: Fix sidebar actions\n\nExecute the spec and plan below. When the plan is detailed, follow it as written — make the changes each step describes, verify each step as it specifies, and do not redesign it. If something is genuinely missing or impossible, stop and ask rather than improvising.\n\nTicket ID: T1\n\nAdd a launch button.\n\nPlan:\n(none)'
		);
	});

	it('interpolates the refine prompt that avoids implementation', () => {
		expect(
			interpolateTicketPrompt(
				{ prompt: refinePrompt },
				{ id: 'T1', title: 'Fix sidebar actions', body: 'Add a launch button.', plan: '' }
			)
		).toBe(
			'Refine this workspace ticket: Fix sidebar actions\n\nTurn this ticket into a complete, self-contained spec and implementation plan that a later "Do" run can execute without making any decisions. You are the strong model doing the thinking up front; the executor that follows may be much weaker, so resolve everything now and leave nothing to infer.\n\nWrite both artifacts into the ticket with `ticket_update` (id T1), keeping any important details from the current body:\n\n1. Spec (ticket body) — goal, verifiable acceptance criteria, requirements and edge cases, explicit in/out of scope, constraints, and every decision with its rationale. No open questions left.\n\n2. Plan (ticket plan) — an ordered, dependency-sorted checklist of small, independently verifiable steps: file paths, symbols, the exact change, and how to verify each. The executor should only follow it, not design it.\n\nResearch the code first so file paths and approaches are accurate. Ask me the questions needed to drive each open decision to a concrete choice. Do not implement anything — refine only writes the spec and plan.\n\nWrite both artifacts tight:\n- Bullets and fragments, not full-sentence prose. No filler; never restate the ticket title or ID.\n- Include a section only if it carries new information; skip or merge ones that don\'t apply.\n- One line per decision; give rationale only when the choice is non-obvious — one sentence of rationale is a paragraph.\n- Every path, symbol, and verification step stays exact; terse wording never cuts content.\n- Match depth to the ticket: small change → tight spec and short checklist, not a padded one.\n\nTicket ID: T1\n\nAdd a launch button.\n\nPlan:\n(none)'
		);
	});

	it('trims dangling blank lines when the ticket body is empty', () => {
		expect(
			interpolateTicketPrompt(
				{ prompt: doPrompt },
				{ id: 'T1', title: 'Fix sidebar actions', body: '  ', plan: '' }
			)
		).toBe(
			'Do this workspace ticket: Fix sidebar actions\n\nExecute the spec and plan below. When the plan is detailed, follow it as written — make the changes each step describes, verify each step as it specifies, and do not redesign it. If something is genuinely missing or impossible, stop and ask rather than improvising.\n\nTicket ID: T1\n\nPlan:\n(none)'
		);
	});

	it('builds encoded draft chat URLs that carry the action id', () => {
		expect(ticketActionDraftUrl('C1', 'T1', 'PT1')).toBe(
			'/conversations/C1?draftTicketId=T1&ticketActionId=PT1'
		);
	});
});

describe('ticket archive helper', () => {
	it('archives a ticket with workspace scoping', async () => {
		const calls: Array<[string, RequestInit]> = [];
		const result = await archiveWorkspaceTicket({
			ticketId: 'T1',
			workspace: '/workspace with spaces',
			fetcher: async (url, init) => {
				calls.push([url, init]);
				return Response.json({ ok: true });
			}
		});

		expect(result).toEqual({ ok: true });
		expect(calls).toEqual([
			[
				'/api/tickets/T1?workspace=%2Fworkspace+with+spaces',
				{
					method: 'DELETE'
				}
			]
		]);
	});

	it('returns the failed archive status', async () => {
		const result = await archiveWorkspaceTicket({
			ticketId: 'T1',
			fetcher: async () => new Response(null, { status: 404 })
		});

		expect(result).toEqual({ ok: false, status: 404 });
	});
});

describe('ticket list pagination helper', () => {
	it('builds an /api/tickets URL with status, workspace, limit and offset', () => {
		expect(
			ticketsPageUrl({ status: 'done', workspace: '/ws with spaces', limit: 20, offset: 40 })
		).toBe('/api/tickets?status=done&workspace=%2Fws+with+spaces&limit=20&offset=40');
	});

	it('omits the workspace param when there is no workspace', () => {
		expect(ticketsPageUrl({ status: 'open', workspace: null, limit: 10, offset: 0 })).toBe(
			'/api/tickets?status=open&limit=10&offset=0'
		);
	});

	it('reports hasMore when a full page is returned', async () => {
		const page = await fetchTicketsPage({
			status: 'open',
			workspace: '/ws',
			limit: 2,
			offset: 0,
			fetcher: async (url) => {
				expect(url).toBe('/api/tickets?status=open&workspace=%2Fws&limit=2&offset=0');
				return Response.json({ tickets: [{ id: 1 }, { id: 2 }] });
			}
		});
		expect(page.tickets.map((t) => t.id)).toEqual([1, 2]);
		expect(page.hasMore).toBe(true);
	});

	it('reports no more when a partial page is returned', async () => {
		const page = await fetchTicketsPage({
			status: 'all',
			limit: 5,
			offset: 5,
			fetcher: async () => Response.json({ tickets: [{ id: 26 }] })
		});
		expect(page.hasMore).toBe(false);
	});

	it('throws on a failed response', async () => {
		await expect(
			fetchTicketsPage({
				status: 'open',
				limit: 5,
				offset: 0,
				fetcher: async () => new Response(null, { status: 500 })
			})
		).rejects.toThrow(/500/);
	});
});
