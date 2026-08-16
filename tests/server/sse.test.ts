import { describe, it, expect, vi, afterEach } from 'vitest';
import { sseResponse, SSE_RETRY_MS } from '../../src/lib/server/sse';

async function readAll(res: Response): Promise<string> {
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let out = '';
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		out += decoder.decode(value);
	}
	return out;
}

function parseDataFrames(text: string): unknown[] {
	return text
		.split('\n\n')
		.map((frame) => frame.trim())
		.filter((frame) => frame.length > 0)
		.map((frame) => frame.split('\n').find((line) => line.startsWith('data: ')))
		.filter((line): line is string => line !== undefined)
		.map((line) => JSON.parse(line.slice('data: '.length)));
}

afterEach(() => {
	vi.useRealTimers();
});

describe('sseResponse', () => {
	it('sets the SSE response headers', async () => {
		async function* empty() {
			/* no events */
		}
		const res = sseResponse(empty());
		expect(res.headers.get('content-type')).toBe('text/event-stream');
		expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
		expect(res.headers.get('connection')).toBe('keep-alive');
		expect(res.headers.get('x-accel-buffering')).toBe('no');
		await readAll(res); // drain so the stream closes cleanly
	});

	it('emits a retry: directive as the first frame', async () => {
		async function* empty() {
			/* no events */
		}
		const text = await readAll(sseResponse(empty()));
		const firstFrame = text.split('\n\n')[0];
		expect(firstFrame).toBe(`retry: ${SSE_RETRY_MS}`);
		expect(SSE_RETRY_MS).toBeGreaterThanOrEqual(5000);
	});

	it('serializes each yielded event as a JSON data frame in order', async () => {
		async function* events() {
			yield { type: 'a', n: 1 };
			yield { type: 'b', text: 'hi' };
			yield { type: 'c', done: true };
		}
		const text = await readAll(sseResponse(events()));
		expect(parseDataFrames(text)).toEqual([
			{ type: 'a', n: 1 },
			{ type: 'b', text: 'hi' },
			{ type: 'c', done: true }
		]);
	});

	it('closes the stream after the iterable completes', async () => {
		async function* events() {
			yield { type: 'only' };
		}
		const res = sseResponse(events());
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		// First read is the retry: directive, second is the data frame, third done.
		const first = await reader.read();
		expect(first.done).toBe(false);
		expect(decoder.decode(first.value)).toBe(`retry: ${SSE_RETRY_MS}\n\n`);
		const second = await reader.read();
		expect(second.done).toBe(false);
		const third = await reader.read();
		expect(third.done).toBe(true);
	});

	it('emits a named stream_error event frame when the iterable throws', async () => {
		async function* events() {
			yield { type: 'ok' };
			throw new Error('boom');
		}
		const text = await readAll(sseResponse(events()));
		// The error frame carries a named `event: stream_error` line so native
		// EventSource clients can listen for it specifically.
		const errorFrame = text
			.split('\n\n')
			.map((f) => f.trim())
			.find((f) => f.startsWith('event: stream_error'));
		expect(errorFrame).toBeDefined();
		expect(errorFrame).toContain('event: stream_error');
		const dataLine = errorFrame!.split('\n').find((l) => l.startsWith('data: '))!;
		expect(JSON.parse(dataLine.slice('data: '.length))).toEqual({
			type: 'error',
			code: 'stream_failed',
			message: 'boom'
		});
		// Back-compat: fetch-based consumers reading data frames still see both.
		const frames = parseDataFrames(text) as Array<Record<string, unknown>>;
		expect(frames).toHaveLength(2);
		expect(frames[0]).toEqual({ type: 'ok' });
		expect(frames[1]).toEqual({ type: 'error', code: 'stream_failed', message: 'boom' });
	});

	it('writes a heartbeat comment when the iterable is idle', async () => {
		vi.useFakeTimers();
		let resolveGate: (() => void) | undefined;
		const gate = new Promise<void>((r) => {
			resolveGate = r;
		});
		async function* events() {
			await gate;
			yield { type: 'after-heartbeat' };
		}
		const res = sseResponse(events());
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();

		// The retry: directive is the first frame, enqueued immediately.
		const retry = await reader.read();
		expect(decoder.decode(retry.value)).toBe(`retry: ${SSE_RETRY_MS}\n\n`);

		// Advance past the 15s heartbeat interval; the comment should arrive
		// before any data frame.
		await vi.advanceTimersByTimeAsync(16_000);
		const beat = await reader.read();
		expect(beat.done).toBe(false);
		const beatText = decoder.decode(beat.value);
		expect(beatText.startsWith(': heartbeat ')).toBe(true);
		expect(beatText.endsWith('\n\n')).toBe(true);

		// Now let the iterable produce its event and finish.
		resolveGate!();
		vi.useRealTimers();
		let rest = '';
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			rest += decoder.decode(value);
		}
		expect(parseDataFrames(rest)).toEqual([{ type: 'after-heartbeat' }]);
	});

	it('emits id: lines when extractId/extractData are provided', async () => {
		async function* events() {
			yield { id: 0, event: { type: 'message.start' } };
			yield { id: 1, event: { type: 'message.delta', text: 'hi' } };
			yield { id: 2, event: { type: 'done' } };
		}
		const text = await readAll(
			sseResponse(events(), {
				extractId: (x) => x.id,
				extractData: (x) => x.event
			})
		);
		// Each frame should carry an id: <n> line followed by data: <json>.
		const frames = text
			.split('\n\n')
			.map((f) => f.trim())
			.filter((f) => f.length > 0 && !f.startsWith(':') && !f.startsWith('retry:'));
		expect(frames).toHaveLength(3);
		expect(frames[0]).toBe('id: 0\ndata: {"type":"message.start"}');
		expect(frames[1]).toBe('id: 1\ndata: {"type":"message.delta","text":"hi"}');
		expect(frames[2]).toBe('id: 2\ndata: {"type":"done"}');
	});

	it('omits the id line when extractId returns undefined', async () => {
		async function* events() {
			yield { id: undefined, event: { type: 'no-id' } };
		}
		const text = await readAll(
			sseResponse(events(), {
				extractId: (x) => x.id,
				extractData: (x) => x.event
			})
		);
		expect(text).not.toContain('id: undefined');
		expect(text).toContain('data: {"type":"no-id"}');
	});
});
