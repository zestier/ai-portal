// Client half of the conversation-payload trim (see `INLINE_FIELD_MAX_BYTES`).
//
// Opening a long conversation ships only small tool args/results and file
// diffs inline; anything larger arrives as a `*Truncated` marker. This module
// fetches the real text on demand from
// `GET /api/conversations/:id/fields/:kind/:recordId`, which returns the raw
// stored string as text/plain.
//
// Fetches are de-duplicated and cached per URL for the life of the page: the
// stored fields are immutable, and a component that remounts (scroll, keyed
// re-render, progressive rendering) must not re-download hundreds of KB.

export type LazyFieldKind = 'tool-args' | 'tool-result' | 'file-diff';

const cache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();

export function lazyFieldUrl(
	conversationId: string,
	kind: LazyFieldKind,
	recordId: string
): string {
	return `/api/conversations/${encodeURIComponent(conversationId)}/fields/${kind}/${encodeURIComponent(recordId)}`;
}

/** Already-resolved value, if this field was fetched earlier on this page. */
export function peekLazyField(
	conversationId: string,
	kind: LazyFieldKind,
	recordId: string
): string | null {
	return cache.get(lazyFieldUrl(conversationId, kind, recordId)) ?? null;
}

export async function fetchLazyField(
	conversationId: string,
	kind: LazyFieldKind,
	recordId: string
): Promise<string> {
	const url = lazyFieldUrl(conversationId, kind, recordId);
	const cached = cache.get(url);
	if (cached !== undefined) return cached;
	const pending = inFlight.get(url);
	if (pending) return pending;

	const promise = (async () => {
		const res = await fetch(url);
		if (!res.ok) {
			throw new Error(
				res.status === 404
					? 'This content is no longer available.'
					: `Could not load content (${res.status}).`
			);
		}
		const text = await res.text();
		cache.set(url, text);
		return text;
	})().finally(() => {
		inFlight.delete(url);
	});
	inFlight.set(url, promise);
	return promise;
}

/** Test seam: drop the memo so a spec can assert on fetch behavior. */
export function resetLazyFieldCache(): void {
	cache.clear();
	inFlight.clear();
}

/** Human-readable size for the "load the full thing" affordance. */
export function formatFieldBytes(bytes: number | undefined): string {
	if (bytes === undefined || !Number.isFinite(bytes)) return '';
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}
