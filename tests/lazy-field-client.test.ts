import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
	fetchLazyField,
	formatFieldBytes,
	lazyFieldUrl,
	peekLazyField,
	resetLazyFieldCache
} from '../src/lib/client/lazy-field';

describe('lazy field client', () => {
	beforeEach(() => {
		resetLazyFieldCache();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('builds an escaped, kind-scoped URL', () => {
		expect(lazyFieldUrl(1, 'tool-result', 'tc/1')).toBe(
			'/api/conversations/1/fields/tool-result/tc%2F1'
		);
	});

	it('fetches once and memoizes, so a remount does not re-download', async () => {
		const fetchMock = vi.fn(async () => new Response('the-result', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		expect(peekLazyField(1, 'tool-result', 't')).toBeNull();
		expect(await fetchLazyField(1, 'tool-result', 't')).toBe('the-result');
		expect(await fetchLazyField(1, 'tool-result', 't')).toBe('the-result');
		expect(peekLazyField(1, 'tool-result', 't')).toBe('the-result');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('de-duplicates concurrent requests for the same field', async () => {
		const fetchMock = vi.fn(async () => new Response('x', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		await Promise.all([fetchLazyField(1, 'tool-args', 't'), fetchLazyField(1, 'tool-args', 't')]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('makes a second concurrent caller genuinely await the first fetch', async () => {
		// The rerun confirmation does `await load(...)` and then insists on having
		// the arguments — so a caller that arrives while a request is in flight
		// must wait for it, not resolve immediately with nothing.
		let release: (r: Response) => void = () => {};
		const pending = new Promise<Response>((res) => {
			release = res;
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(() => pending)
		);
		let firstDone = false;
		let secondDone = false;
		const a = fetchLazyField(1, 'tool-args', 't').then((v) => {
			firstDone = true;
			return v;
		});
		const b = fetchLazyField(1, 'tool-args', 't').then((v) => {
			secondDone = true;
			return v;
		});
		await Promise.resolve();
		expect(firstDone).toBe(false);
		expect(secondDone).toBe(false);
		release(new Response('args-text', { status: 200 }));
		expect(await a).toBe('args-text');
		expect(await b).toBe('args-text');
	});

	it('throws a retryable error and caches nothing on failure', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response('nope', { status: 500 }))
			.mockResolvedValueOnce(new Response('recovered', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(fetchLazyField(1, 'file-diff', 'e')).rejects.toThrow(/Could not load/);
		// The failure must not poison the memo: a retry has to be able to succeed.
		expect(await fetchLazyField(1, 'file-diff', 'e')).toBe('recovered');
	});

	it('reports a missing field distinctly from a transport failure', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('', { status: 404 }))
		);
		await expect(fetchLazyField(1, 'tool-result', 'gone')).rejects.toThrow(/no longer available/);
	});

	it('formats withheld sizes for the load affordance', () => {
		expect(formatFieldBytes(512)).toBe('512 B');
		expect(formatFieldBytes(4096)).toBe('4 KB');
		expect(formatFieldBytes(3 * 1024 * 1024)).toBe('3.0 MB');
		expect(formatFieldBytes(undefined)).toBe('');
	});
});
