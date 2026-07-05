import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetConfigForTests } from '../src/lib/server/config';
import { lmStudioProvider } from '../src/lib/server/providers/lm-studio-provider';
import type { ProviderOpenOptions } from '../src/lib/server/providers/provider';
import type { PortalEvent } from '../src/lib/types';
import { setupLocalEnv } from './helpers/env';
import { PORTAL_SYSTEM_GUIDANCE } from '../src/lib/server/runtime/system-guidance';

const systemGuidanceMsg = { role: 'system', content: PORTAL_SYSTEM_GUIDANCE };

const baseOpts: ProviderOpenOptions = {
	provider: 'lm-studio',
	conversationId: 'conv-lm-studio',
	userId: 'user-1',
	workingDirectory: '/tmp',
	model: 'local-model',
	policy: 'prompt'
};

function sseResponse(chunks: string[]): Response {
	const encoder = new TextEncoder();
	let i = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i >= chunks.length) {
				controller.close();
				return;
			}
			controller.enqueue(encoder.encode(chunks[i++]));
		}
	});
	return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

async function collect(iterable: AsyncIterable<PortalEvent>): Promise<PortalEvent[]> {
	const events: PortalEvent[] = [];
	for await (const event of iterable) events.push(event);
	return events;
}

beforeEach(async () => {
	await setupLocalEnv('portal-lm-studio-');
	process.env.LMSTUDIO_BASE_URL = 'http://127.0.0.1:1234';
	delete process.env.LMSTUDIO_API_KEY;
	resetConfigForTests();
});

afterEach(() => {
	delete process.env.LMSTUDIO_BASE_URL;
	delete process.env.LMSTUDIO_API_KEY;
	delete process.env.OPENAI_COMPATIBLE_TEMPERATURE;
	delete process.env.OPENAI_COMPATIBLE_TOP_P;
	delete process.env.OPENAI_COMPATIBLE_PRESENCE_PENALTY;
	delete process.env.OPENAI_COMPATIBLE_FREQUENCY_PENALTY;
	resetConfigForTests();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('lmStudioProvider', () => {
	it('primes a model against the LM Studio OpenAI-compatible /v1 endpoint', async () => {
		process.env.LMSTUDIO_API_KEY = 'lm-token';
		resetConfigForTests();
		const fetchMock = vi.fn(async () => Response.json({ choices: [{ message: { content: '' } }] }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			lmStudioProvider.primeModel!('local-model', { signal: new AbortController().signal })
		).resolves.toBeUndefined();

		expect(lmStudioProvider.capabilities.localModelLoad.primeAfterModelSwap).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('http://127.0.0.1:1234/v1/chat/completions');
		expect((init.headers as Record<string, string>).authorization).toBe('Bearer lm-token');
		expect(JSON.parse(String(init.body))).toMatchObject({
			model: 'local-model',
			max_tokens: 1,
			stream: false
		});
	});

	it('reuses OpenAI-compatible live controls except unsupported runtime modes', async () => {
		expect(lmStudioProvider.capabilities.controls).toEqual({
			mode: false,
			approveAll: true,
			resetSessionApprovals: false
		});
		expect(lmStudioProvider.capabilities.features.mcpInfoEvents).toMatchObject({
			supported: false,
			behavior: 'unsupported'
		});

		const session = await lmStudioProvider.openSession(baseOpts);

		expect(session.setMode).toBeDefined();
		expect(session.setApproveAll).toBeDefined();
		expect(session.resetSessionApprovals).toBeUndefined();
	});

	it('discovers native LM Studio models with context metadata and optional API token', async () => {
		process.env.LMSTUDIO_API_KEY = 'lm-token';
		resetConfigForTests();
		const fetchMock = vi.fn(async () =>
			Response.json({
				models: [
					{
						type: 'llm',
						key: 'publisher/model',
						display_name: 'Local Model',
						max_context_length: 131072,
						loaded_instances: [{ id: 'publisher/model', config: { context_length: 8192 } }]
					},
					{ type: 'embedding', key: 'embedder', display_name: 'Embedder' }
				]
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(lmStudioProvider.listModels('user-1')).resolves.toEqual([
			{
				id: 'publisher/model',
				name: 'Local Model',
				capabilities: { limits: { max_context_window_tokens: 8192 } }
			}
		]);
		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:1234/api/v1/models',
			expect.objectContaining({
				headers: {
					'content-type': 'application/json',
					authorization: 'Bearer lm-token'
				}
			})
		);
	});

	it('streams OpenAI-compatible chat chunks with LM Studio context usage metadata', async () => {
		const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const href = String(url);
			if (href.endsWith('/api/v1/models')) {
				return Response.json({
					models: [
						{
							type: 'llm',
							key: 'local-model',
							display_name: 'Local Model',
							max_context_length: 8192
						}
					]
				});
			}
			expect(href).toBe('http://127.0.0.1:1234/v1/chat/completions');
			expect(JSON.parse(String(init?.body))).toMatchObject({
				model: 'local-model',
				messages: [systemGuidanceMsg, { role: 'user', content: 'hello' }],
				tools: expect.arrayContaining([
					expect.objectContaining({
						type: 'function',
						function: expect.objectContaining({ name: 'git_status' })
					})
				]),
				tool_choice: 'auto',
				stream: true,
				stream_options: { include_usage: true }
			});
			expect(JSON.parse(String(init?.body))).not.toHaveProperty('temperature');
			expect(JSON.parse(String(init?.body))).not.toHaveProperty('top_p');
			expect(JSON.parse(String(init?.body))).not.toHaveProperty('presence_penalty');
			expect(JSON.parse(String(init?.body))).not.toHaveProperty('frequency_penalty');
			return sseResponse([
				'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
				'data: {"choices":[],"usage":{"prompt_tokens":42,"completion_tokens":3,"total_tokens":45}}\n\n',
				'data: [DONE]\n\n'
			]);
		});
		vi.stubGlobal('fetch', fetchMock);
		const session = await lmStudioProvider.openSession(baseOpts);

		const events = await collect(session.send('hello', new AbortController().signal));

		expect(events.map((event) => event.type)).toEqual([
			'message.start',
			'message.delta',
			'context.usage',
			'message.end',
			'done'
		]);
		expect(events).toContainEqual(
			expect.objectContaining({ type: 'message.delta', text: 'Hello' })
		);
		expect(events).toContainEqual(
			expect.objectContaining({ type: 'context.usage', currentTokens: 45, tokenLimit: 8192 })
		);
		expect(session.providerSessionId).toBe(baseOpts.conversationId);
	});

	it('derives context usage token limit from model metadata when no context override is set', async () => {
		const opts = { ...baseOpts, model: 'local-model-large' };
		const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			void init;
			const href = String(url);
			if (href.endsWith('/api/v1/models')) {
				return Response.json({
					models: [
						{
							type: 'llm',
							key: opts.model,
							display_name: 'Local Model',
							max_context_length: 131072,
							loaded_instances: [{ id: opts.model, config: { context_length: 16384 } }]
						}
					]
				});
			}
			return sseResponse([
				'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
				'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":25}}\n\n',
				'data: [DONE]\n\n'
			]);
		});
		vi.stubGlobal('fetch', fetchMock);
		const session = await lmStudioProvider.openSession(opts);

		const events = await collect(session.send('hello', new AbortController().signal));

		expect(events).toContainEqual(
			expect.objectContaining({ type: 'context.usage', currentTokens: 125, tokenLimit: 16384 })
		);
		expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
			stream_options: { include_usage: true }
		});
	});

	it('reseeds stateless chats from provided OpenAI-compatible initial messages', async () => {
		const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			void init;
			const href = String(url);
			if (href.endsWith('/api/v1/models')) {
				return Response.json({ models: [] });
			}
			return sseResponse([
				'data: {"choices":[{"delta":{"content":"continued"}}]}\n\n',
				'data: [DONE]\n\n'
			]);
		});
		vi.stubGlobal('fetch', fetchMock);
		const session = await lmStudioProvider.openSession({
			...baseOpts,
			providerSessionId: 'resp_prev',
			initialMessages: [
				{ role: 'user', content: 'remember alpha', status: 'complete' },
				{ role: 'assistant', content: 'alpha remembered', status: 'complete' }
			]
		});

		await collect(session.send('follow up', new AbortController().signal));

		const chatCall = fetchMock.mock.calls.find(([, init]) => init?.body);
		expect(JSON.parse(String(chatCall?.[1]?.body))).toMatchObject({
			messages: [
				systemGuidanceMsg,
				{ role: 'user', content: 'remember alpha' },
				{ role: 'assistant', content: 'alpha remembered' },
				{ role: 'user', content: 'follow up' }
			]
		});
		expect(JSON.parse(String(chatCall?.[1]?.body))).not.toHaveProperty('previous_response_id');
		expect(session.providerSessionId).toBe('resp_prev');
	});

	it('surfaces clear connection errors', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Promise.reject(new TypeError('fetch failed')))
		);
		const session = await lmStudioProvider.openSession(baseOpts);

		const events = await collect(session.send('hello', new AbortController().signal));

		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'error',
				code: 'send_failed',
				message: expect.stringContaining('Unable to connect to LM Studio backend')
			})
		);
	});
});
