// Stream POST + SSE: yields parsed JSON events from a `data:` SSE response.
//
// Optional callbacks:
//   onStatus   — invoked once with the HTTP status code after the response
//                headers arrive (lets callers distinguish e.g. 200 vs 204).
//   onActivity — invoked every time a chunk is read from the network,
//                including heartbeat comments. Useful for stall detection
//                since heartbeats are otherwise swallowed silently.

export interface StreamSseInit extends RequestInit {
	signal?: AbortSignal;
	onStatus?: (status: number) => void;
	onActivity?: () => void;
}

export async function* streamSse<T>(url: string, init: StreamSseInit = {}): AsyncIterable<T> {
	const { onStatus, onActivity, ...fetchInit } = init;
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

export function csrfToken(): string {
	if (typeof document === 'undefined') return '';
	const m = document.querySelector('meta[name="csrf-token"]');
	return m?.getAttribute('content') ?? '';
}
