// Stream POST + SSE: yields parsed JSON events from a `data:` SSE response.
//
// Optional callbacks:
//   onStatus   — invoked once with the HTTP status code after the response
//                headers arrive (lets callers distinguish e.g. 200 vs 204).
//   onActivity — invoked every time a chunk is read from the network,
//                including heartbeat comments. Useful for stall detection
//                since heartbeats are otherwise swallowed silently.

import { csrfToken } from './csrf';

// Base reconnect interval (ms) for client-managed EventSource reconnection.
// Mirrors the server's `SSE_RETRY_MS` directive; the client adds jitter on top.
export const SSE_RECONNECT_BASE_MS = 5000;

// Compute a jittered reconnect delay. After a server restart every client would
// otherwise reconnect on the same fixed interval, re-creating the thundering
// herd the `retry:` directive is meant to soften. We spread reconnections
// uniformly across `[base, 2*base)` — a `base` floor avoids hammering on the
// first retry, while the jitter de-correlates the herd ("equal jitter").
export function reconnectDelayMs(baseMs = SSE_RECONNECT_BASE_MS, rand: () => number = Math.random) {
	return baseMs + Math.floor(rand() * baseMs);
}

export interface StreamSseInit extends RequestInit {
	signal?: AbortSignal;
	onStatus?: (status: number) => void;
	onActivity?: () => void;
}

export async function* streamSse<T>(url: string, init: StreamSseInit = {}): AsyncIterable<T> {
	const { onStatus, onActivity, ...fetchInit } = init;
	// This transport uses fetch (not native EventSource), so custom headers
	// work — mutating SSE requests must carry the CSRF token like any other
	// state-changing fetch. The global interceptor also covers this, but we
	// set it explicitly here for the non-GET SSE entrypoint.
	const method = (fetchInit.method ?? 'GET').toUpperCase();
	if (method !== 'GET') {
		const headers = new Headers(fetchInit.headers);
		if (!headers.has('x-csrf-token')) {
			const token = csrfToken();
			if (token) headers.set('x-csrf-token', token);
		}
		fetchInit.headers = headers;
	}
	const res = await fetch(url, fetchInit);
	onStatus?.(res.status);
	if (!res.ok) {
		throw new Error(`SSE fetch failed: ${res.status}`);
	}
	// 204 / empty body: nothing to stream.
	if (res.status === 204 || !res.body) return;
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			onActivity?.();
			buf += decoder.decode(value, { stream: true });
			let idx: number;
			while ((idx = buf.indexOf('\n\n')) !== -1) {
				const raw = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				const lines = raw.split('\n');
				const dataLines: string[] = [];
				for (const line of lines) {
					if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
				}
				if (dataLines.length === 0) continue; // comment / heartbeat
				const payload = dataLines.join('\n');
				try {
					yield JSON.parse(payload) as T;
				} catch (err) {
					console.warn('streamSse: discarding malformed SSE payload', payload, err);
				}
			}
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			/* ignore */
		}
	}
}
