// In-process OpenAI-compatible stub model for the pi path, gated by `PI_STUB=1`.
// Lets e2e tests exercise the full turn-runner / SSE / persistence pipeline
// without real model credentials or network. The reply is deterministic
// (`Stubbed reply to: <last user message>`) so tests can assert on the literal
// prompt.
//
// The stub is a real `node:http` server on 127.0.0.1 (ephemeral port) registered
// into the pi `ModelRuntime` as an `openai-completions` provider, so the pi SDK
// drives it over actual HTTP — keeping the pi request path honest.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { loadConfig } from '../config';
import type { PiModel } from './session';

const STUB_PROVIDER = 'pi-stub';
const STUB_MODEL_ID = 'stub-model';
const STUB_API_KEY = 'pi-stub-key';

interface StubRequestBody {
	messages?: unknown[];
	model?: unknown;
	stream?: unknown;
}

let serverPromise: Promise<string> | null = null;
let stubRegistered = false;

/** Base URL of the shared stub server (started lazily, kept for process lifetime). */
export function getStubServerBaseUrl(): Promise<string> {
	serverPromise ??= startServer();
	return serverPromise;
}

export function isPiStubMode(): boolean {
	return loadConfig().PI_STUB;
}

/**
 * Register the stub model on the shared runtime and return it. Idempotent per
 * process: the provider is registered once, then reused.
 */
export async function getStubModel(runtime: ModelRuntime): Promise<PiModel | undefined> {
	if (!stubRegistered) {
		const baseUrl = await getStubServerBaseUrl();
		runtime.registerProvider(STUB_PROVIDER, {
			name: 'pi stub',
			api: 'openai-completions',
			baseUrl,
			apiKey: STUB_API_KEY,
			authHeader: true,
			models: [
				{
					id: STUB_MODEL_ID,
					name: 'Pi Stub Model',
					reasoning: false,
					input: ['text'],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200_000,
					maxTokens: 4096
				}
			]
		});
		stubRegistered = true;
	}
	return runtime.getModel(STUB_PROVIDER, STUB_MODEL_ID);
}

function startServer(): Promise<string> {
	const server = createServer((req, res) => {
		void handleRequest(req, res).catch(() => {
			if (!res.headersSent) {
				res.statusCode = 500;
				res.end('stub error');
			}
		});
	});
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			const port = typeof addr === 'object' && addr ? addr.port : 0;
			resolve(`http://127.0.0.1:${port}/v1`);
		});
	});
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? '/', 'http://127.0.0.1');
	if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
		res.statusCode = 404;
		res.end('not found');
		return;
	}
	const body = (await readJsonBody(req).catch(() => null)) as StubRequestBody | null;
	if (!body || !Array.isArray(body.messages)) {
		res.statusCode = 400;
		res.end('bad request');
		return;
	}
	const userText = lastUserText(body.messages);
	const reply = `Stubbed reply to: ${userText}`;
	const id = `chatcmpl-stub-${Date.now()}`;
	const created = Math.floor(Date.now() / 1000);
	const model = typeof body.model === 'string' ? body.model : STUB_MODEL_ID;

	if (body.stream === true) {
		writeSseReply(res, {
			id,
			created,
			model,
			reply,
			slowStart: userText.includes('@trigger-slow-start')
		});
	} else {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(
			JSON.stringify({
				id,
				object: 'chat.completion',
				created,
				model,
				choices: [
					{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }
				],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
			})
		);
	}
}

// Stream the reply as OpenAI chat-completions SSE chunks so pi's
// openai-completions provider parses real stream deltas (not one blob).
const SLOW_START_HOLD_MS = 1200;
function writeSseReply(
	res: ServerResponse,
	opts: { id: string; created: number; model: string; reply: string; slowStart?: boolean }
): void {
	res.writeHead(200, { 'Content-Type': 'text/event-stream' });
	const chunks = opts.reply.match(/.{1,16}/g) ?? [opts.reply];
	const finishIndex = chunks.length - 1;
	const chunkEvent = (delta: string, finishReason: string | null) =>
		`data: ${JSON.stringify({
			id: opts.id,
			object: 'chat.completion.chunk',
			created: opts.created,
			model: opts.model,
			choices: [{ index: 0, delta: delta ? { content: delta } : {}, finish_reason: finishReason }]
		})}\n\n`;
	// `@trigger-slow-start` in the prompt holds the first byte so the turn sits
	// in the pre-delta "setting up" state long enough to assert on; otherwise the
	// first chunk goes out immediately and the rest drain on a short timer
	// (mirrors a real model's token cadence).
	const emit = () => {
		for (let i = 0; i <= finishIndex; i++) {
			if (i === 0) {
				res.write(chunkEvent(chunks[0], finishIndex === 0 ? 'stop' : null));
				continue;
			}
			setTimeout(() => {
				if (i === finishIndex) res.write(chunkEvent(chunks[i], 'stop'));
				else res.write(chunkEvent(chunks[i], null));
			}, i * 2);
		}
		res.write(
			`data: ${JSON.stringify({
				id: opts.id,
				object: 'chat.completion.chunk',
				created: opts.created,
				model: opts.model,
				choices: []
			})}\n\n`
		);
		setTimeout(
			() => {
				res.write('data: [DONE]\n\n');
				res.end();
			},
			(finishIndex + 1) * 2
		);
	};
	if (opts.slowStart) setTimeout(emit, SLOW_START_HOLD_MS);
	else emit();
}

function lastUserText(messages: unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message || typeof message !== 'object') continue;
		const { role, content } = message as { role?: unknown; content?: unknown };
		if (role !== 'user') continue;
		if (typeof content === 'string') return content;
		if (Array.isArray(content)) {
			const text = content
				.map((part) =>
					part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
						? ((part as { text: string }).text as string)
						: ''
				)
				.join('\n')
				.trim();
			if (text) return text;
		}
	}
	return '(no user message)';
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let data = '';
		req.setEncoding('utf8');
		req.on('data', (chunk: string) => {
			data += chunk;
			if (data.length > 1_000_000) {
				reject(new Error('stub body too large'));
				req.destroy();
			}
		});
		req.on('end', () => {
			try {
				resolve(JSON.parse(data));
			} catch (err) {
				reject(err);
			}
		});
		req.on('error', reject);
	});
}
