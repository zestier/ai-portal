import { describe, expect, it, vi } from 'vitest';
import { createTicketLaunchChat } from '../src/lib/client/ticket-chat-launch';
import { patchTicketStatus } from '../src/lib/client/ticket-status';
import type { ChatPromptTemplate, WorkspaceTicket } from '../src/lib/types';

const ticket: WorkspaceTicket = {
	id: 'ticket-1',
	userId: 'user-1',
	workspaceKey: '/workspace',
	title: 'Fix sidebar actions',
	body: 'Add a launch button.',
	plan: '',
	priority: 'P2',
	status: 'open',
	sourceConversationId: null,
	sourceMessageId: null,
	createdAt: 1,
	updatedAt: 1,
	closedAt: null
};

function action(overrides: Partial<ChatPromptTemplate> = {}): ChatPromptTemplate {
	return {
		id: 'action-do',
		userId: 'user-1',
		type: 'ticket-action',
		title: 'Do',
		description: '',
		prompt:
			'Do this workspace ticket: {{ticket.title}}\n\nTicket ID: {{ticket.id}}\n\n{{ticket.body}}\n\nPlan:\n{{ticket.plan}}',
		launchBehavior: 'send',
		conversationMode: null,
		model: null,
		status: 'open',
		pinned: true,
		orderIndex: 10,
		createdAt: 1,
		updatedAt: 1,
		archivedAt: null,
		...overrides
	};
}

describe('createTicketLaunchChat', () => {
	it('creates a conversation, posts the interpolated prompt as a turn, and returns the href', async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const fetcher = vi.fn(async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			if (url === '/api/conversations') {
				return Response.json({ conversation: { id: 'conv-1' } }, { status: 201 });
			}
			return new Response(null, { status: 200 });
		});

		const result = await createTicketLaunchChat({
			ticket,
			template: action(),
			workdir: '/workspace',
			fetcher
		});

		expect(result).toEqual({
			ok: true,
			conversationId: 'conv-1',
			href: '/conversations/conv-1'
		});
		expect(calls[0].url).toBe('/api/conversations');
		expect(JSON.parse(calls[0].init.body as string)).toEqual({
			title: 'Fix sidebar actions',
			workdir: '/workspace'
		});
		expect(calls[1].url).toBe('/api/conversations/conv-1/turns');
		expect(JSON.parse(calls[1].init.body as string)).toEqual({
			content:
				'Do this workspace ticket: Fix sidebar actions\n\nTicket ID: ticket-1\n\nAdd a launch button.\n\nPlan:\n(none)'
		});
	});

	it('applies the conversation-mode override at creation', async () => {
		const fetcher = vi.fn(async (url: string, init: RequestInit) => {
			void init;
			if (url === '/api/conversations') {
				return Response.json({ conversation: { id: 'conv-2' } }, { status: 201 });
			}
			return new Response(null, { status: 200 });
		});

		await createTicketLaunchChat({
			ticket,
			template: action({ conversationMode: 'interactive' }),
			workdir: '/workspace',
			fetcher
		});

		const [, init] = fetcher.mock.calls[0];
		expect(JSON.parse(init.body as string)).toEqual({
			title: 'Fix sidebar actions',
			workdir: '/workspace',
			mode: 'interactive'
		});
	});

	it('applies the model override at creation', async () => {
		const fetcher = vi.fn(async (url: string, init: RequestInit) => {
			void init;
			if (url === '/api/conversations') {
				return Response.json({ conversation: { id: 'conv-3' } }, { status: 201 });
			}
			return new Response(null, { status: 200 });
		});

		await createTicketLaunchChat({
			ticket,
			template: action({ model: 'claude-sonnet-4.6' }),
			workdir: '/workspace',
			fetcher
		});

		const [, init] = fetcher.mock.calls[0];
		expect(JSON.parse(init.body as string)).toEqual({
			title: 'Fix sidebar actions',
			workdir: '/workspace',
			model: 'claude-sonnet-4.6'
		});
	});

	it('reports a create-stage failure without posting a turn', async () => {
		const fetcher = vi.fn(async (url: string, init: RequestInit) => {
			void url;
			void init;
			return new Response(null, { status: 500 });
		});

		const result = await createTicketLaunchChat({ ticket, template: action(), fetcher });

		expect(result).toEqual({ ok: false, stage: 'create', status: 500 });
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it('deletes the orphan conversation when posting the turn fails', async () => {
		const fetcher = vi.fn(async (url: string, init: RequestInit) => {
			void init;
			if (url === '/api/conversations') {
				return Response.json({ conversation: { id: 'conv-3' } }, { status: 201 });
			}
			if (url.endsWith('/turns')) return new Response(null, { status: 502 });
			return new Response(null, { status: 200 });
		});

		const result = await createTicketLaunchChat({ ticket, template: action(), fetcher });

		expect(result).toEqual({ ok: false, stage: 'launch', status: 502 });
		const deleteCall = fetcher.mock.calls.find(
			([url, init]) => url === '/api/conversations/conv-3' && init?.method === 'DELETE'
		);
		expect(deleteCall).toBeTruthy();
	});

	it('cleans up and rethrows when a request throws after the conversation is created', async () => {
		const fetcher = vi.fn(async (url: string, init: RequestInit) => {
			void init;
			if (url === '/api/conversations') {
				return Response.json({ conversation: { id: 'conv-4' } }, { status: 201 });
			}
			if (url.endsWith('/turns')) throw new Error('network');
			return new Response(null, { status: 200 });
		});

		await expect(createTicketLaunchChat({ ticket, template: action(), fetcher })).rejects.toThrow(
			'network'
		);
		const deleteCall = fetcher.mock.calls.find(
			([url, init]) => url === '/api/conversations/conv-4' && init?.method === 'DELETE'
		);
		expect(deleteCall).toBeTruthy();
	});
});

describe('patchTicketStatus', () => {
	it('PATCHes the ticket with the target status', async () => {
		const fetcher = vi.fn(async (url: string, init: RequestInit) => {
			void url;
			void init;
			return Response.json({ ok: true }, { status: 200 });
		});

		const result = await patchTicketStatus({ ticketId: 'ticket-1', status: 'done', fetcher });

		expect(result).toEqual({ ok: true });
		const [url, init] = fetcher.mock.calls[0];
		expect(url).toBe('/api/tickets/ticket-1');
		expect(init.method).toBe('PATCH');
		expect(JSON.parse(init.body as string)).toEqual({ status: 'done' });
	});

	it('reports the HTTP status on failure', async () => {
		const fetcher = vi.fn(async (url: string, init: RequestInit) => {
			void url;
			void init;
			return new Response(null, { status: 404 });
		});

		const result = await patchTicketStatus({ ticketId: 'ticket-1', status: 'archived', fetcher });

		expect(result).toEqual({ ok: false, status: 404 });
	});

	it('encodes the ticket id in the URL', async () => {
		const fetcher = vi.fn(async (url: string, init: RequestInit) => {
			void url;
			void init;
			return Response.json({ ok: true }, { status: 200 });
		});

		await patchTicketStatus({ ticketId: 'a/b', status: 'open', fetcher });

		expect(fetcher.mock.calls[0][0]).toBe('/api/tickets/a%2Fb');
	});
});
