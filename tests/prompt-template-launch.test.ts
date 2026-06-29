import { describe, expect, it, vi } from 'vitest';
import {
	createPromptTemplateDraftChat,
	createPromptTemplateRefineChat,
	promptTemplateDraftUrl,
	promptTemplateRefineUrl
} from '../src/lib/client/prompt-template-launch';

describe('prompt template chat launcher', () => {
	it('creates a conversation and returns a draft URL without posting a turn', async () => {
		const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			void url;
			void init;
			return Response.json({ conversation: { id: 'conv-1' } }, { status: 201 });
		});

		const result = await createPromptTemplateDraftChat({
			template: { id: 'debug-error', source: 'builtin', title: 'Debug an error' },
			fetcher
		});

		expect(result).toEqual({
			ok: true,
			href: '/conversations/conv-1?promptTemplateSource=builtin&promptTemplateId=debug-error'
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
		const [url, init] = fetcher.mock.calls[0];
		expect(String(url)).toBe('/api/conversations');
		expect(String(url)).not.toContain('/turns');
		expect(JSON.parse(init?.body as string)).toEqual({ title: 'Debug an error' });
	});

	it('encodes custom template draft URLs', () => {
		expect(promptTemplateDraftUrl('conv/1', { id: 'tmpl/1', source: 'custom' })).toBe(
			'/conversations/conv%2F1?promptTemplateSource=custom&promptTemplateId=tmpl%2F1'
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
			template: { id: 'debug-error', source: 'builtin', title: 'Debug an error' },
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
			template: { id: 'debug-error', source: 'builtin', title: 'Debug an error' },
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
			template: { id: 'tmpl-1', title: 'My helper' },
			fetcher
		});

		expect(result).toEqual({
			ok: true,
			href: '/conversations/conv-9?refinePromptTemplateId=tmpl-1'
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
			template: { id: 'tmpl-1', title: 'My helper' },
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
			template: { id: 'tmpl-2', title: 'Another' },
			fetcher,
			signal: controller.signal
		});

		const [, init] = fetcher.mock.calls[0];
		expect(init?.signal).toBe(controller.signal);
	});

	it('encodes refine URLs', () => {
		expect(promptTemplateRefineUrl('conv/3', 'tmpl/3')).toBe(
			'/conversations/conv%2F3?refinePromptTemplateId=tmpl%2F3'
		);
	});
});
