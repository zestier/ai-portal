import { describe, expect, it, vi } from 'vitest';
import { createTicketDraftChat } from '../src/lib/client/ticket-chat-launch';
import type { WorkspaceTicket } from '../src/lib/types';

const ticket: WorkspaceTicket = {
	id: 'ticket-1',
	userId: 'user-1',
	workspaceKey: '/workspace',
	title: 'Fix sidebar actions',
	body: 'Add a launch button.',
	status: 'open',
	sourceConversationId: null,
	sourceMessageId: null,
	createdAt: 1,
	updatedAt: 1,
	closedAt: null
};

describe('createTicketDraftChat', () => {
	it('creates a conversation and returns a draft URL without posting a turn', async () => {
		const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			void url;
			void init;
			return Response.json({ conversation: { id: 'conv-1' } }, { status: 201 });
		});

		const result = await createTicketDraftChat({
			ticket,
			mode: 'do',
			workdir: '/workspace',
			fetcher
		});

		expect(result).toEqual({
			ok: true,
			href: '/conversations/conv-1?draftTicketId=ticket-1&ticketMode=do'
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
		const [url, init] = fetcher.mock.calls[0];
		expect(String(url)).toBe('/api/conversations');
		expect(String(url)).not.toContain('/turns');
		expect(JSON.parse(init?.body as string)).toEqual({
			title: 'Fix sidebar actions',
			workdir: '/workspace'
		});
	});

	it('forces interactive mode when refining a ticket', async () => {
		const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			void url;
			void init;
			return Response.json({ conversation: { id: 'conv-2' } }, { status: 201 });
		});

		const result = await createTicketDraftChat({
			ticket,
			mode: 'refine',
			workdir: '/workspace',
			fetcher
		});

		expect(result).toEqual({
			ok: true,
			href: '/conversations/conv-2?draftTicketId=ticket-1&ticketMode=refine'
		});
		const [, init] = fetcher.mock.calls[0];
		expect(JSON.parse(init?.body as string)).toEqual({
			title: 'Refine ticket: Fix sidebar actions',
			workdir: '/workspace',
			mode: 'interactive'
		});
	});
});
