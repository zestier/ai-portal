import { describe, expect, it, vi } from 'vitest';
import { createTicketDraftChat } from '../src/lib/client/ticket-chat-launch';
import type { ChatPromptTemplate, WorkspaceTicket } from '../src/lib/types';

const ticket: WorkspaceTicket = {
	id: 'ticket-1',
	userId: 'user-1',
	workspaceKey: '/workspace',
	title: 'Fix sidebar actions',
	body: 'Add a launch button.',
	plan: '',
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
			'Do this workspace ticket: {{ticket.title}}\n\nTicket ID: {{ticket.id}}\n\n{{ticket.body}}',
		launchBehavior: 'draft',
		conversationMode: null,
		status: 'open',
		pinned: true,
		orderIndex: 10,
		createdAt: 1,
		updatedAt: 1,
		archivedAt: null,
		...overrides
	};
}

describe('createTicketDraftChat', () => {
	it('creates a conversation and returns a draft URL + interpolated prompt without posting a turn', async () => {
		const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			void url;
			void init;
			return Response.json({ conversation: { id: 'conv-1' } }, { status: 201 });
		});

		const result = await createTicketDraftChat({
			ticket,
			template: action(),
			workdir: '/workspace',
			fetcher
		});

		expect(result).toEqual({
			ok: true,
			href: '/conversations/conv-1?draftTicketId=ticket-1&ticketActionId=action-do',
			prompt:
				'Do this workspace ticket: Fix sidebar actions\n\nTicket ID: ticket-1\n\nAdd a launch button.'
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

	it('applies the action conversation-mode override at creation', async () => {
		const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			void url;
			void init;
			return Response.json({ conversation: { id: 'conv-2' } }, { status: 201 });
		});

		const result = await createTicketDraftChat({
			ticket,
			template: action({ id: 'action-refine', conversationMode: 'interactive' }),
			workdir: '/workspace',
			fetcher
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.href).toBe(
				'/conversations/conv-2?draftTicketId=ticket-1&ticketActionId=action-refine'
			);
		}
		const [, init] = fetcher.mock.calls[0];
		expect(JSON.parse(init?.body as string)).toEqual({
			title: 'Fix sidebar actions',
			workdir: '/workspace',
			mode: 'interactive'
		});
	});
});
