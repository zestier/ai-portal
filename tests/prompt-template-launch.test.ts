import { describe, expect, it, vi } from 'vitest';
import {
	createPromptTemplateDraftChat,
	createPromptTemplateLaunchChat,
	createPromptTemplateRefineChat,
	promptTemplateDraftUrl,
	promptTemplateRefineUrl
} from '../src/lib/client/prompt-template-launch';
import { templateLaunchDefaults } from '../src/lib/prompt-templates';

describe('prompt template chat launcher', () => {
	it('creates a conversation and returns a draft URL without posting a turn', async () => {
		const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			void url;
			void init;
			return Response.json({ conversation: { id: 'conv-1' } }, { status: 201 });
		});

		const result = await createPromptTemplateDraftChat({
			template: { id: -2, source: 'builtin', title: 'Debug an error' },
			fetcher
		});

		expect(result).toEqual({
			ok: true,
			href: '/conversations/conv-1?promptTemplateSource=builtin&promptTemplateId=-2'
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
		const [url, init] = fetcher.mock.calls[0];
		expect(String(url)).toBe('/api/conversations');
		expect(String(url)).not.toContain('/turns');
		expect(JSON.parse(init?.body as string)).toEqual({
			title: 'Debug an error',
			promptTemplateId: -2
		});
	});

	it('encodes custom template draft URLs', () => {
		expect(promptTemplateDraftUrl(1, { id: 1, source: 'custom' })).toBe(
			'/conversations/1?promptTemplateSource=custom&promptTemplateId=1'
		);
	});

	it('forwards an AbortSignal to the conversations fetch init', async () => {
		const controller = new AbortController();
		const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			void url;
			void init;
			return Response.json({ conversation: { id: 'conv-2' } }, { status: 201 });
		});

		await createPromptTemplateDraftChat({
			template: { id: -2, source: 'builtin', title: 'Debug an error' },
			fetcher,
			signal: controller.signal
		});

		const [, init] = fetcher.mock.calls[0];
		expect(init?.signal).toBe(controller.signal);
	});

	it('propagates an AbortError when the signal is aborted mid-flight', async () => {
		const controller = new AbortController();
		const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => {
					reject(new DOMException('Aborted', 'AbortError'));
				});
			});
		});

		const pending = createPromptTemplateDraftChat({
			template: { id: -2, source: 'builtin', title: 'Debug an error' },
			fetcher,
			signal: controller.signal
		});
		controller.abort();

		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
	});
});

describe('prompt template refine launcher', () => {
	it('creates a conversation titled "Refine: <title>" and returns a refine URL', async () => {
		const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			void url;
			void init;
			return Response.json({ conversation: { id: 'conv-9' } }, { status: 201 });
		});

		const result = await createPromptTemplateRefineChat({
			template: { id: 1, title: 'My helper' },
			fetcher
		});

		expect(result).toEqual({
			ok: true,
			href: '/conversations/conv-9?refinePromptTemplateId=1'
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
		const [url, init] = fetcher.mock.calls[0];
		expect(String(url)).toBe('/api/conversations');
		expect(String(url)).not.toContain('/turns');
		expect(JSON.parse(init?.body as string)).toEqual({ title: 'Refine: My helper' });
	});

	it('reports a non-ok conversation create as a failure', async () => {
		const fetcher = vi.fn(async () => new Response(null, { status: 500 }));
		const result = await createPromptTemplateRefineChat({
			template: { id: 1, title: 'My helper' },
			fetcher
		});
		expect(result).toEqual({ ok: false, status: 500 });
	});

	it('forwards an AbortSignal to the conversations fetch init', async () => {
		const controller = new AbortController();
		const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			void url;
			void init;
			return Response.json({ conversation: { id: 'conv-3' } }, { status: 201 });
		});

		await createPromptTemplateRefineChat({
			template: { id: 2, title: 'Another' },
			fetcher,
			signal: controller.signal
		});

		const [, init] = fetcher.mock.calls[0];
		expect(init?.signal).toBe(controller.signal);
	});

	it('encodes refine URLs', () => {
		expect(promptTemplateRefineUrl(3, 3)).toBe('/conversations/3?refinePromptTemplateId=3');
	});
});

describe('prompt template send/review launcher', () => {
	const template = { id: 1, title: 'Weekly review' };
	const options = {
		prompt: 'Reviewed prompt',
		workspace: 'worktree' as const,
		conversationMode: 'autopilot' as const,
		approvalMode: 'auto-deny' as const,
		model: 'claude-sonnet-4.6'
	};

	it('creates a conversation with the resolved options and posts the prompt as a turn', async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), ...(init !== undefined ? { init } : {}) });
			if (String(url) === '/api/conversations') {
				return Response.json({ conversation: { id: 'conv-1' } }, { status: 201 });
			}
			return new Response(null, { status: 200 });
		});

		const result = await createPromptTemplateLaunchChat({ template, options, fetcher });

		expect(result).toEqual({ ok: true, href: '/conversations/conv-1' });
		expect(JSON.parse(calls[0].init?.body as string)).toEqual({
			title: 'Weekly review',
			promptTemplateId: 1,
			workspace: { kind: 'worktree' },
			mode: 'autopilot',
			approvalMode: 'auto-deny',
			model: 'claude-sonnet-4.6'
		});
		expect(calls[1].url).toBe('/api/conversations/conv-1/turns');
		expect(JSON.parse(calls[1].init?.body as string)).toEqual({ content: 'Reviewed prompt' });
	});

	it('deletes the new conversation when the first turn fails', async () => {
		const calls: string[] = [];
		const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
			if (String(url) === '/api/conversations' && init?.method === 'POST') {
				return Response.json({ conversation: { id: 'conv-2' } }, { status: 201 });
			}
			if (String(url).endsWith('/turns')) return new Response(null, { status: 500 });
			return new Response(null, { status: 200 });
		});

		const result = await createPromptTemplateLaunchChat({ template, options, fetcher });

		expect(result).toEqual({ ok: false, stage: 'launch', status: 500 });
		// No orphan chat is left behind when the launch turn fails.
		expect(calls).toContain('DELETE /api/conversations/conv-2');
	});

	it('reports a failed create as the create stage without posting a turn', async () => {
		const fetcher = vi.fn(async () => new Response(null, { status: 500 }));
		const result = await createPromptTemplateLaunchChat({ template, options, fetcher });
		expect(result).toEqual({ ok: false, stage: 'create', status: 500 });
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
});

describe('templateLaunchDefaults', () => {
	it('collapses a missing workspace preference to the shared checkout', () => {
		expect(
			templateLaunchDefaults(
				{ workspaceMode: null, conversationMode: null, approvalMode: null, model: null },
				'Prompt'
			)
		).toEqual({
			prompt: 'Prompt',
			workspace: 'shared',
			conversationMode: null,
			approvalMode: null,
			model: null
		});
	});

	it('carries the template’s pinned workspace and overrides', () => {
		expect(
			templateLaunchDefaults(
				{
					workspaceMode: 'worktree',
					conversationMode: 'autopilot',
					approvalMode: 'auto-deny',
					model: 'gpt-5.5'
				},
				'Prompt'
			)
		).toEqual({
			prompt: 'Prompt',
			workspace: 'worktree',
			conversationMode: 'autopilot',
			approvalMode: 'auto-deny',
			model: 'gpt-5.5'
		});
	});
});
