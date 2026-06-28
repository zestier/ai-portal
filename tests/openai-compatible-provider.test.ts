import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetConfigForTests } from '../src/lib/server/config';
import { openAICompatibleProvider } from '../src/lib/server/providers/openai-compatible-provider';
import type { ProviderOpenOptions } from '../src/lib/server/providers/provider';
import type { PortalEvent } from '../src/lib/types';
import { resolve as resolveInteractive } from '../src/lib/server/runtime/interactive-requests';
import { setupLocalEnv } from './helpers/env';
import { PORTAL_SYSTEM_GUIDANCE } from '../src/lib/server/runtime/system-guidance';

const systemGuidanceMsg = { role: 'system', content: PORTAL_SYSTEM_GUIDANCE };

const baseOpts: ProviderOpenOptions = {
	provider: 'openai-compatible',
	conversationId: 'conv-openai-compatible',
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

function writeSse(res: ServerResponse, chunks: string[]) {
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	for (const chunk of chunks) res.write(chunk);
	res.end();
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function startFakeStreamingServer(
	handler: (body: unknown, req: IncomingMessage, res: ServerResponse) => void | Promise<void>
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
	const server = createServer(async (req, res) => {
		try {
			if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
				res.writeHead(404).end();
				return;
			}
			await handler(await readJson(req), req, res);
		} catch (e) {
			res
				.writeHead(500, { 'content-type': 'application/json' })
				.end(JSON.stringify({ error: { message: e instanceof Error ? e.message : String(e) } }));
		}
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		close: async () => {
			await new Promise<void>((resolve, reject) =>
				server.close((err) => (err ? reject(err) : resolve()))
			);
		}
	};
}

async function collect(iterable: AsyncIterable<PortalEvent>): Promise<PortalEvent[]> {
	const events: PortalEvent[] = [];
	for await (const event of iterable) events.push(event);
	return events;
}

async function persistedOpts(
	overrides: Partial<ProviderOpenOptions> = {}
): Promise<ProviderOpenOptions> {
	const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
	const conversations = await import('../src/lib/server/db/repos/conversations');
	const user = ensureLocalUser();
	conversations.create(user.id, {
		id: baseOpts.conversationId,
		title: 'OpenAI-compatible test',
		workdir: baseOpts.workingDirectory,
		model: baseOpts.model,
		...(baseOpts.provider !== undefined ? { provider: baseOpts.provider } : {})
	});
	return { ...baseOpts, userId: user.id, ...overrides };
}

beforeEach(async () => {
	await setupLocalEnv('portal-openai-compatible-');
	process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://127.0.0.1:1234/v1';
	delete process.env.OPENAI_COMPATIBLE_API_KEY;
	resetConfigForTests();
});

afterEach(() => {
	delete process.env.OPENAI_COMPATIBLE_BASE_URL;
	delete process.env.OPENAI_COMPATIBLE_API_KEY;
	delete process.env.OPENAI_COMPATIBLE_MAX_TOOL_ITERATIONS;
	delete process.env.OPENAI_COMPATIBLE_TEMPERATURE;
	delete process.env.OPENAI_COMPATIBLE_TOP_P;
	delete process.env.OPENAI_COMPATIBLE_PRESENCE_PENALTY;
	delete process.env.OPENAI_COMPATIBLE_FREQUENCY_PENALTY;
	resetConfigForTests();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('openAICompatibleProvider', () => {
	it('documents Copilot runtime degradation for OpenAI-compatible sessions', () => {
		expect(openAICompatibleProvider.capabilities.controls).toEqual({
			mode: false,
			approveAll: true,
			resetSessionApprovals: false
		});
		expect(openAICompatibleProvider.capabilities.features).toMatchObject({
			modes: { supported: false, behavior: 'no-op' },
			approveAll: { supported: true, behavior: 'portal-enforced' },
			contextUsage: { supported: true, behavior: 'supported' },
			subagents: { supported: false, behavior: 'unsupported' },
			mcpInfoEvents: { supported: false, behavior: 'unsupported' },
			planExit: { supported: false, behavior: 'unsupported' },
			elicitation: { supported: false, behavior: 'unsupported' }
		});
		expect(openAICompatibleProvider.capabilities.optionalRuntimeFeatures).toMatchObject({
			contextWindowEvents: true,
			contextCompactionEvents: false,
			subagentLifecycleEvents: false,
			exitPlanModeCallbacks: false,
			elicitationCallbacks: false
		});
	});

	it('discovers models from an OpenAI-compatible /models endpoint with optional API key', async () => {
		process.env.OPENAI_COMPATIBLE_API_KEY = 'test-key';
		resetConfigForTests();
		const fetchMock = vi.fn(async () =>
			Response.json({ data: [{ id: 'local-chat-model', name: 'Local Chat Model' }] })
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(openAICompatibleProvider.listModels('user-1')).resolves.toEqual([
			{ id: 'local-chat-model', name: 'Local Chat Model' }
		]);
		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:1234/v1/models',
			expect.objectContaining({
				headers: {
					'content-type': 'application/json',
					authorization: 'Bearer test-key'
				}
			})
		);
	});

	it('falls back to manual model entry when model discovery is unavailable', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ error: { message: 'nope' } }, { status: 404 }))
		);

		await expect(openAICompatibleProvider.listModels('user-1')).resolves.toEqual([]);
	});

	it('streams chat completion chunks into PortalEvent messages', async () => {
		const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
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
				stream: true
			});
			expect(JSON.parse(String(init?.body))).not.toHaveProperty('temperature');
			expect(JSON.parse(String(init?.body))).not.toHaveProperty('top_p');
			expect(JSON.parse(String(init?.body))).not.toHaveProperty('presence_penalty');
			expect(JSON.parse(String(init?.body))).not.toHaveProperty('frequency_penalty');
			return sseResponse([
				'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
				'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
				'data: [DONE]\n\n'
			]);
		});
		vi.stubGlobal('fetch', fetchMock);
		const session = await openAICompatibleProvider.openSession(baseOpts);

		const events = await collect(session.send('hello', new AbortController().signal));

		expect(events.map((event) => event.type)).toEqual([
			'message.start',
			'message.delta',
			'message.delta',
			'message.end',
			'done'
		]);
		expect(events[1]).toMatchObject({ type: 'message.delta', text: 'Hel' });
		expect(events[2]).toMatchObject({ type: 'message.delta', text: 'lo' });
		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:1234/v1/chat/completions',
			expect.objectContaining({ method: 'POST' })
		);
	});

	it('seeds exactly one leading system guidance message, not re-sent per turn', async () => {
		const fetchMock = vi.fn(async () =>
			sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n'])
		);
		vi.stubGlobal('fetch', fetchMock);
		const session = await openAICompatibleProvider.openSession(baseOpts);

		await collect(session.send('first', new AbortController().signal));
		await collect(session.send('second', new AbortController().signal));

		expect(fetchMock).toHaveBeenCalledTimes(2);
		for (const call of fetchMock.mock.calls as unknown as Array<[unknown, RequestInit?]>) {
			const sent = JSON.parse(String(call[1]?.body)).messages as Array<{
				role: string;
				content: string;
			}>;
			// One system message, always first — present each turn because the
			// session keeps it at the head of the running message array, not because
			// it's re-injected.
			expect(sent.filter((m) => m.role === 'system')).toEqual([systemGuidanceMsg]);
			expect(sent[0]).toEqual(systemGuidanceMsg);
		}
	});

	it('sends configured OpenAI-compatible sampling controls with chat requests', async () => {
		process.env.OPENAI_COMPATIBLE_TEMPERATURE = '1.1';
		process.env.OPENAI_COMPATIBLE_TOP_P = '0.9';
		process.env.OPENAI_COMPATIBLE_PRESENCE_PENALTY = '0.4';
		process.env.OPENAI_COMPATIBLE_FREQUENCY_PENALTY = '0.6';
		resetConfigForTests();
		const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
			void _url;
			void _init;
			return sseResponse([
				'data: {"choices":[{"delta":{"content":"varied"}}]}\n\n',
				'data: [DONE]\n\n'
			]);
		});
		vi.stubGlobal('fetch', fetchMock);
		const session = await openAICompatibleProvider.openSession(baseOpts);

		await collect(session.send('hello', new AbortController().signal));

		expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
			temperature: 1.1,
			top_p: 0.9,
			presence_penalty: 0.4,
			frequency_penalty: 0.6
		});
	});

	it('streams chat-only responses from an OpenAI-compatible fake server', async () => {
		const requests: unknown[] = [];
		const server = await startFakeStreamingServer((body, req, res) => {
			requests.push(body);
			expect(req.headers.authorization).toBe('Bearer fake-key');
			writeSse(res, [
				'data: {"choices":[{"delta":{"content":"network "}}]}\n\n',
				'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
				'data: [DONE]\n\n'
			]);
		});
		process.env.OPENAI_COMPATIBLE_BASE_URL = server.baseUrl;
		process.env.OPENAI_COMPATIBLE_API_KEY = 'fake-key';
		resetConfigForTests();
		try {
			const session = await openAICompatibleProvider.openSession(baseOpts);

			const events = await collect(session.send('hello network', new AbortController().signal));

			expect(events.map((event) => event.type)).toEqual([
				'message.start',
				'message.delta',
				'message.delta',
				'message.end',
				'done'
			]);
			expect(events.filter((event) => event.type === 'message.delta')).toEqual([
				expect.objectContaining({ text: 'network ' }),
				expect.objectContaining({ text: 'ok' })
			]);
			expect(requests).toHaveLength(1);
			expect(requests[0]).toMatchObject({
				model: 'local-model',
				messages: [systemGuidanceMsg, { role: 'user', content: 'hello network' }],
				tools: expect.arrayContaining([
					expect.objectContaining({
						type: 'function',
						function: expect.objectContaining({ name: 'git_status' })
					})
				]),
				tool_choice: 'auto',
				stream: true
			});
		} finally {
			await server.close();
		}
	});

	it('restores prior context when a normal follow-up opens a fresh session', async () => {
		const opts = await persistedOpts();
		const messageRepo = await import('../src/lib/server/db/repos/messages');
		messageRepo.append(opts.conversationId, { role: 'user', content: 'remember alpha' });
		messageRepo.append(opts.conversationId, { role: 'assistant', content: 'alpha remembered' });
		const followUp = messageRepo.append(opts.conversationId, {
			role: 'user',
			content: 'what did I ask you to remember?'
		});
		const fetchMock = vi.fn(async (...args: [string | URL | Request, RequestInit?]) => {
			void args;
			return sseResponse([
				'data: {"choices":[{"delta":{"content":"alpha"}}]}\n\n',
				'data: [DONE]\n\n'
			]);
		});
		vi.stubGlobal('fetch', fetchMock);
		const session = await openAICompatibleProvider.openSession({
			...opts,
			initialMessages: [
				{ role: 'user', content: 'remember alpha', status: 'complete' },
				{ role: 'assistant', content: 'alpha remembered', status: 'complete' }
			]
		});

		await collect(session.send(followUp.content, new AbortController().signal));

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
			messages: [
				systemGuidanceMsg,
				{ role: 'user', content: 'remember alpha' },
				{ role: 'assistant', content: 'alpha remembered' },
				{ role: 'user', content: 'what did I ask you to remember?' }
			]
		});
	});

	it('does not double-inject prior context on a live OpenAI-compatible session', async () => {
		const fetchMock = vi.fn(async (...args: [string | URL | Request, RequestInit?]) => {
			void args;
			if (fetchMock.mock.calls.length === 1) {
				return sseResponse([
					'data: {"choices":[{"delta":{"content":"alpha remembered"}}]}\n\n',
					'data: [DONE]\n\n'
				]);
			}
			return sseResponse([
				'data: {"choices":[{"delta":{"content":"alpha"}}]}\n\n',
				'data: [DONE]\n\n'
			]);
		});
		vi.stubGlobal('fetch', fetchMock);
		const session = await openAICompatibleProvider.openSession(baseOpts);

		await collect(session.send('remember alpha', new AbortController().signal));
		await collect(session.send('what did I ask you to remember?', new AbortController().signal));

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
			messages: [
				systemGuidanceMsg,
				{ role: 'user', content: 'remember alpha' },
				{ role: 'assistant', content: 'alpha remembered' },
				{ role: 'user', content: 'what did I ask you to remember?' }
			]
		});
	});

	it('handles SSE comments, non-data fields, multiline data, and array text parts', async () => {
		const fetchMock = vi.fn(async () =>
			sseResponse([
				': keep-alive\n',
				'event: ignored\n',
				'data: {"choices":[{"delta":{"content":[{"text":"Hel"}]}}]}\n\n',
				'data: {"choices":[\n',
				'data: {"delta":{"content":"lo"}}\n',
				'data: ]}\n\n',
				'data: [DONE]\n\n'
			])
		);
		vi.stubGlobal('fetch', fetchMock);
		const session = await openAICompatibleProvider.openSession(baseOpts);

		const events = await collect(session.send('hello', new AbortController().signal));

		expect(events.filter((event) => event.type === 'message.delta')).toEqual([
			expect.objectContaining({ text: 'Hel' }),
			expect.objectContaining({ text: 'lo' })
		]);
	});

	it('surfaces clear backend connection errors', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Promise.reject(new TypeError('fetch failed')))
		);
		const session = await openAICompatibleProvider.openSession(baseOpts);

		const events = await collect(session.send('hello', new AbortController().signal));

		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'error',
				code: 'send_failed',
				message: expect.stringContaining('Unable to connect to OpenAI compatible backend')
			})
		);
		expect(events.map((event) => event.type).slice(-2)).toEqual(['message.end', 'done']);
	});

	it('surfaces a friendly error when a mid-stream chunk is not JSON', async () => {
		const fetchMock = vi.fn(async () =>
			sseResponse([
				'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
				'data: <html><body>502 Bad Gateway</body></html>\n\n'
			])
		);
		vi.stubGlobal('fetch', fetchMock);
		const session = await openAICompatibleProvider.openSession(baseOpts);

		const events = await collect(session.send('hello', new AbortController().signal));

		const error = events.find((event) => event.type === 'error');
		expect(error).toMatchObject({
			type: 'error',
			code: 'send_failed',
			message: expect.stringContaining('non-JSON chunk')
		});
		expect(error?.message ?? '').not.toContain('<html>');
	});

	it('preserves a non-JSON error body when the chat request fails', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response('<html><body>503 Service Unavailable</body></html>', {
						status: 503,
						headers: { 'content-type': 'text/html' }
					})
			)
		);
		const session = await openAICompatibleProvider.openSession(baseOpts);

		const events = await collect(session.send('hello', new AbortController().signal));

		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'error',
				code: 'send_failed',
				message: expect.stringContaining('503 Service Unavailable')
			})
		);
	});

	it('aborts an in-flight streaming request when the session is aborted', async () => {
		const fetchMock = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) =>
				await new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					expect(signal).toBeInstanceOf(AbortSignal);
					signal?.addEventListener(
						'abort',
						() => reject(new DOMException('aborted', 'AbortError')),
						{ once: true }
					);
				})
		);
		vi.stubGlobal('fetch', fetchMock);
		const session = await openAICompatibleProvider.openSession(baseOpts);
		const iter = session.send('hello', new AbortController().signal)[Symbol.asyncIterator]();

		expect((await iter.next()).value).toMatchObject({ type: 'message.start' });
		const next = iter.next();
		await session.abort();

		await expect(next).resolves.toMatchObject({
			value: { type: 'error', code: 'aborted' },
			done: false
		});
		await expect(iter.next()).resolves.toMatchObject({
			value: { type: 'message.end' },
			done: false
		});
		await expect(iter.next()).resolves.toMatchObject({
			value: { type: 'done' },
			done: false
		});
	});

	it('aborts mid-body-stream when the session is aborted after headers arrive', async () => {
		const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const signal = init?.signal;
			expect(signal).toBeInstanceOf(AbortSignal);
			const encoder = new TextEncoder();
			let started = false;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					// Headers/first chunk arrive; then the body hangs until the
					// caller signal aborts. If cleanup() severed the link, this
					// stream would never error and the read would orphan.
					signal?.addEventListener(
						'abort',
						() => controller.error(new DOMException('aborted', 'AbortError')),
						{ once: true }
					);
				},
				pull(controller) {
					if (!started) {
						started = true;
						controller.enqueue(encoder.encode('data: {"choices":[{"delta":{}}]}\n\n'));
					}
				}
			});
			return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
		});
		vi.stubGlobal('fetch', fetchMock);
		const session = await openAICompatibleProvider.openSession(baseOpts);
		const iter = session.send('hello', new AbortController().signal)[Symbol.asyncIterator]();

		expect((await iter.next()).value).toMatchObject({ type: 'message.start' });
		const next = iter.next();
		await session.abort();

		await expect(next).resolves.toMatchObject({
			value: { type: 'error', code: 'aborted' },
			done: false
		});
	});

	it('aborts immediately when the caller signal is already aborted', async () => {
		const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			expect(init?.signal).toBeInstanceOf(AbortSignal);
			expect(init?.signal?.aborted).toBe(true);
			throw new DOMException('aborted', 'AbortError');
		});
		vi.stubGlobal('fetch', fetchMock);
		const session = await openAICompatibleProvider.openSession(baseOpts);
		const ac = new AbortController();
		ac.abort();

		const events = await collect(session.send('hello', ac.signal));

		expect(events.map((event) => event.type)).toEqual([
			'message.start',
			'error',
			'message.end',
			'done'
		]);
		expect(events[1]).toMatchObject({ type: 'error', code: 'aborted' });
	});

	it('executes requested portal tools and loops until a final assistant response', async () => {
		const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
			void _url;
			void _init;
			if (fetchMock.mock.calls.length === 1) {
				return sseResponse([
					'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_git_status","type":"function","function":{"name":"git_status","arguments":"{}"}}]}}]}\n\n',
					'data: [DONE]\n\n'
				]);
			}
			return sseResponse([
				'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
				'data: [DONE]\n\n'
			]);
		});
		vi.stubGlobal('fetch', fetchMock);
		const session = await openAICompatibleProvider.openSession(
			await persistedOpts({ policy: 'allow-all' })
		);

		const events = await collect(session.send('status please', new AbortController().signal));

		expect(events.map((event) => event.type)).toEqual([
			'message.start',
			'tool.call',
			'tool.result',
			'message.delta',
			'message.end',
			'done'
		]);
		expect(events[1]).toMatchObject({
			type: 'tool.call',
			toolCallId: 'call_git_status',
			tool: 'git_status',
			args: {}
		});
		expect(events[2]).toMatchObject({
			type: 'tool.result',
			toolCallId: 'call_git_status',
			ok: true
		});
		expect(events[3]).toMatchObject({ type: 'message.delta', text: 'done' });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
			messages: expect.arrayContaining([
				expect.objectContaining({
					role: 'assistant',
					tool_calls: [
						expect.objectContaining({
							id: 'call_git_status',
							function: expect.objectContaining({ name: 'git_status' })
						})
					]
				}),
				expect.objectContaining({ role: 'tool', tool_call_id: 'call_git_status' })
			])
		});
	});

	it('does not double a tool call when a chunk carries both message and delta tool_calls', async () => {
		const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
			void _url;
			void _init;
			if (fetchMock.mock.calls.length === 1) {
				// Some OpenAI-compatible proxies wrapping non-streaming models emit a
				// complete message-style tool call AND a delta for the same index in a
				// single chunk. Applying both would concatenate (double) the
				// name/arguments and corrupt the JSON args.
				return sseResponse([
					'data: {"choices":[{"message":{"tool_calls":[{"id":"call_git_status","type":"function","function":{"name":"git_status","arguments":"{}"}}]},"delta":{"tool_calls":[{"index":0,"id":"call_git_status","type":"function","function":{"name":"git_status","arguments":"{}"}}]}}]}\n\n',
					'data: [DONE]\n\n'
				]);
			}
			return sseResponse([
				'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
				'data: [DONE]\n\n'
			]);
		});
		vi.stubGlobal('fetch', fetchMock);
		const session = await openAICompatibleProvider.openSession(
			await persistedOpts({ policy: 'allow-all' })
		);

		const events = await collect(session.send('status please', new AbortController().signal));

		expect(events.map((event) => event.type)).toEqual([
			'message.start',
			'tool.call',
			'tool.result',
			'message.delta',
			'message.end',
			'done'
		]);
		expect(events[1]).toMatchObject({
			type: 'tool.call',
			toolCallId: 'call_git_status',
			tool: 'git_status',
			args: {}
		});
		expect(events[2]).toMatchObject({
			type: 'tool.result',
			toolCallId: 'call_git_status',
			ok: true
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const assistantBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as {
			messages: Array<{
				role: string;
				tool_calls?: Array<{ function: { name: string; arguments: string } }>;
			}>;
		};
		const assistantMsg = assistantBody.messages.find((m) => m.role === 'assistant' && m.tool_calls);
		expect(assistantMsg?.tool_calls).toHaveLength(1);
		expect(assistantMsg?.tool_calls?.[0].function.name).toBe('git_status');
		expect(assistantMsg?.tool_calls?.[0].function.arguments).toBe('{}');
	});

	it('executes approved tool calls against an OpenAI-compatible fake server', async () => {
		const requests: unknown[] = [];
		const server = await startFakeStreamingServer((body, _req, res) => {
			requests.push(body);
			if (requests.length === 1) {
				writeSse(res, [
					'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_git_status","type":"function","function":{"name":"git_status","arguments":"{}"}}]}}]}\n\n',
					'data: [DONE]\n\n'
				]);
				return;
			}
			writeSse(res, [
				'data: {"choices":[{"delta":{"content":"approved"}}]}\n\n',
				'data: [DONE]\n\n'
			]);
		});
		process.env.OPENAI_COMPATIBLE_BASE_URL = server.baseUrl;
		resetConfigForTests();
		try {
			const opts = await persistedOpts({ policy: 'prompt' });
			const settings = await import('../src/lib/server/db/repos/settings');
			settings.addGrant({
				userId: opts.userId,
				conversationId: opts.conversationId,
				tool: 'git_status',
				permissionKind: 'custom-tool',
				scope: { kind: 'any' },
				decision: 'allow'
			});
			const session = await openAICompatibleProvider.openSession(opts);

			const events = await collect(session.send('status please', new AbortController().signal));

			expect(events.map((event) => event.type)).toEqual([
				'message.start',
				'tool.call',
				'tool.result',
				'message.delta',
				'message.end',
				'done'
			]);
			expect(events[2]).toMatchObject({
				type: 'tool.result',
				toolCallId: 'call_git_status',
				ok: true
			});
			expect(events[3]).toMatchObject({ type: 'message.delta', text: 'approved' });
			expect(requests).toHaveLength(2);
			expect(requests[1]).toMatchObject({
				messages: expect.arrayContaining([
					expect.objectContaining({
						role: 'assistant',
						tool_calls: [
							expect.objectContaining({
								id: 'call_git_status',
								function: expect.objectContaining({ name: 'git_status' })
							})
						]
					}),
					expect.objectContaining({ role: 'tool', tool_call_id: 'call_git_status' })
				])
			});
		} finally {
			await server.close();
		}
	});

	it('enforces permission callbacks before running portal tools', async () => {
		const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
			void _url;
			void _init;
			if (fetchMock.mock.calls.length === 1) {
				return sseResponse([
					'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_prompted","type":"function","function":{"name":"permission_capabilities","arguments":"{}"}}]}}]}\n\n',
					'data: [DONE]\n\n'
				]);
			}
			return sseResponse([
				'data: {"choices":[{"delta":{"content":"after permission"}}]}\n\n',
				'data: [DONE]\n\n'
			]);
		});
		vi.stubGlobal('fetch', fetchMock);
		const opts = await persistedOpts({ policy: 'deny-all' });
		const settings = await import('../src/lib/server/db/repos/settings');
		settings.addGrant({
			userId: opts.userId,
			conversationId: opts.conversationId,
			tool: 'permission_capabilities',
			permissionKind: 'custom-tool',
			scope: { kind: 'any' },
			decision: 'deny'
		});
		const session = await openAICompatibleProvider.openSession(opts);
		const iter = session
			.send('status please', new AbortController().signal)
			[Symbol.asyncIterator]();

		expect((await iter.next()).value).toMatchObject({ type: 'message.start' });
		expect((await iter.next()).value).toMatchObject({
			type: 'tool.call',
			toolCallId: 'call_prompted',
			tool: 'permission_capabilities'
		});
		expect((await iter.next()).value).toMatchObject({
			type: 'tool.result',
			toolCallId: 'call_prompted',
			ok: false,
			summary: expect.stringContaining('Permission denied')
		});
		expect((await iter.next()).value).toMatchObject({
			type: 'message.delta',
			text: 'after permission'
		});
	});

	it('streams progress and partial output from a custom tool via the handler context', async () => {
		const repo = mkdtempSync(join(tmpdir(), 'portal-commit-stream-'));
		const g = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
		g(['init', '-q', '-b', 'main']);
		g(['config', 'user.email', 't@example.com']);
		g(['config', 'user.name', 'T']);
		g(['config', 'commit.gpgsign', 'false']);
		writeFileSync(join(repo, 'a.txt'), 'one\n');
		g(['add', '.']);
		g(['commit', '-q', '-m', 'init']);
		// A pre-commit hook that prints incremental output → partial snapshots.
		const hooksDir = join(repo, '.git', 'hooks');
		mkdirSync(hooksDir, { recursive: true });
		const hookPath = join(hooksDir, 'pre-commit');
		writeFileSync(hookPath, '#!/bin/sh\necho "hook running"\nexit 0\n', { mode: 0o755 });
		chmodSync(hookPath, 0o755);
		writeFileSync(join(repo, 'a.txt'), 'one\nchanged\n');

		const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
			void _url;
			void _init;
			if (fetchMock.mock.calls.length === 1) {
				return sseResponse([
					'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_commit","type":"function","function":{"name":"git_commit","arguments":"{\\"paths\\":\\"all\\",\\"subject\\":\\"streamed commit\\"}"}}]}}]}\n\n',
					'data: [DONE]\n\n'
				]);
			}
			return sseResponse([
				'data: {"choices":[{"delta":{"content":"committed"}}]}\n\n',
				'data: [DONE]\n\n'
			]);
		});
		vi.stubGlobal('fetch', fetchMock);

		try {
			const opts = await persistedOpts({ policy: 'prompt', workingDirectory: repo });
			const session = await openAICompatibleProvider.openSession(opts);

			// Drive the iterator manually so we can approve the always-prompt
			// git_commit permission request inline (it blocks the handler).
			const iter = session
				.send('commit please', new AbortController().signal)
				[Symbol.asyncIterator]();
			const events: PortalEvent[] = [];
			for (;;) {
				const { value, done } = await iter.next();
				if (done) break;
				events.push(value);
				if (value.type === 'interactive.request') {
					resolveInteractive(value.request.requestId, opts.userId, {
						kind: 'permission',
						decision: 'allow-once'
					});
				}
			}

			const types = events.map((e) => e.type);
			const callIdx = types.indexOf('tool.call');
			const resultIdx = types.indexOf('tool.result');
			expect(callIdx).toBeGreaterThanOrEqual(0);
			expect(resultIdx).toBeGreaterThan(callIdx);

			const progress = events.filter((e) => e.type === 'tool.progress');
			const partials = events.filter((e) => e.type === 'tool.partial_output');
			expect(progress.length).toBeGreaterThan(0);
			expect(partials.length).toBeGreaterThan(0);
			// Streamed events are bound to the originating tool call and interleave
			// strictly between tool.call and tool.result.
			for (const ev of [...progress, ...partials]) {
				expect((ev as { toolCallId: string }).toolCallId).toBe('call_commit');
				const idx = events.indexOf(ev);
				expect(idx).toBeGreaterThan(callIdx);
				expect(idx).toBeLessThan(resultIdx);
			}
			expect(progress.map((e) => (e as { message: string }).message)).toContain(
				'running git commit (pre-commit / commit-msg hooks)…'
			);
			expect(partials.some((e) => (e as { output: string }).output.includes('hook running'))).toBe(
				true
			);
			expect(events[resultIdx]).toMatchObject({
				type: 'tool.result',
				toolCallId: 'call_commit',
				ok: true
			});
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it('keeps mode no-op at the provider API while approve-all remains portal-enforced', async () => {
		const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
			void _url;
			void _init;
			if (fetchMock.mock.calls.length === 1) {
				return sseResponse([
					'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_git_status","type":"function","function":{"name":"git_status","arguments":"{}"}}]}}]}\n\n',
					'data: [DONE]\n\n'
				]);
			}
			return sseResponse([
				'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
				'data: [DONE]\n\n'
			]);
		});
		vi.stubGlobal('fetch', fetchMock);
		const session = await openAICompatibleProvider.openSession(
			await persistedOpts({ policy: 'prompt' })
		);

		await session.setMode?.('plan');
		await session.setApproveAll?.(true);
		expect(session.resetSessionApprovals).toBeUndefined();

		const events = await collect(session.send('status please', new AbortController().signal));

		expect(events.map((event) => event.type)).toEqual([
			'message.start',
			'tool.call',
			'tool.result',
			'message.delta',
			'message.end',
			'done'
		]);
		expect(events).not.toContainEqual(expect.objectContaining({ type: 'interactive.request' }));
		expect(events).not.toContainEqual(expect.objectContaining({ type: 'session.settings' }));
		expect(events).not.toContainEqual(expect.objectContaining({ type: 'context.usage' }));
		expect(events).not.toContainEqual(expect.objectContaining({ type: 'subagent.lifecycle' }));
		const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
		expect(firstBody).toMatchObject({ model: 'local-model', stream: true, tool_choice: 'auto' });
		expect(firstBody).not.toHaveProperty('mode');
		expect(firstBody).not.toHaveProperty('approve_all');
		expect(firstBody).not.toHaveProperty('approveAllTools');
	});

	it('stops tool-calling with an explicit error at the configured max iterations', async () => {
		process.env.OPENAI_COMPATIBLE_MAX_TOOL_ITERATIONS = '1';
		resetConfigForTests();
		const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
			void _url;
			void _init;
			return sseResponse([
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_loop","type":"function","function":{"name":"git_status","arguments":"{}"}}]}}]}\n\n',
				'data: [DONE]\n\n'
			]);
		});
		vi.stubGlobal('fetch', fetchMock);
		const session = await openAICompatibleProvider.openSession(
			await persistedOpts({ policy: 'allow-all' })
		);

		const events = await collect(session.send('loop', new AbortController().signal));

		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'error',
				code: 'max_tool_iterations',
				message: expect.stringContaining('1 tool-calling iterations')
			})
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('rejects sends after the session is disposed', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const session = await openAICompatibleProvider.openSession(baseOpts);

		await session.dispose();
		const events = await collect(session.send('hello', new AbortController().signal));

		expect(fetchMock).not.toHaveBeenCalled();
		expect(events.map((event) => event.type)).toEqual([
			'message.start',
			'error',
			'message.end',
			'done'
		]);
		expect(events[1]).toMatchObject({
			type: 'error',
			code: 'session_disposed',
			message: 'Session disposed.'
		});
	});

	it('aborts an in-flight streaming request when the session is disposed', async () => {
		const fetchMock = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) =>
				await new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					expect(signal).toBeInstanceOf(AbortSignal);
					signal?.addEventListener(
						'abort',
						() => reject(new DOMException('aborted', 'AbortError')),
						{ once: true }
					);
				})
		);
		vi.stubGlobal('fetch', fetchMock);
		const session = await openAICompatibleProvider.openSession(baseOpts);
		const iter = session.send('hello', new AbortController().signal)[Symbol.asyncIterator]();

		expect((await iter.next()).value).toMatchObject({ type: 'message.start' });
		const next = iter.next();
		await session.dispose();

		await expect(next).resolves.toMatchObject({
			value: { type: 'error', code: 'aborted' },
			done: false
		});
		await expect(iter.next()).resolves.toMatchObject({
			value: { type: 'message.end' },
			done: false
		});
		await expect(iter.next()).resolves.toMatchObject({
			value: { type: 'done' },
			done: false
		});
	});
});
