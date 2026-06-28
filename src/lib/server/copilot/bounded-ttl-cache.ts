// A small Map-backed cache with TTL expiry and an LRU size cap. Plain Maps used
// as per-userId caches grow unbounded on long-running servers (every distinct
// user seen becomes a permanent entry, even after its TTL lapses). This bounds
// growth two ways: expired entries are deleted on access, and the map is capped
// at `maxEntries` with least-recently-used eviction (Map preserves insertion
// order, so the first key is the oldest).

export interface BoundedTtlCacheOptions {
	ttlMs: number;
	maxEntries: number;
	now?: () => number;
}

export class BoundedTtlCache<K, V> {
	private readonly entries = new Map<K, { at: number; value: V }>();
	private readonly ttlMs: number;
	private readonly maxEntries: number;
	private readonly now: () => number;

	constructor({ ttlMs, maxEntries, now = Date.now }: BoundedTtlCacheOptions) {
		if (maxEntries < 1) throw new Error('BoundedTtlCache maxEntries must be >= 1');
		this.ttlMs = ttlMs;
		this.maxEntries = maxEntries;
		this.now = now;
	}

	get(key: K): V | undefined {
		const hit = this.entries.get(key);
		if (!hit) return undefined;
		if (this.now() - hit.at >= this.ttlMs) {
			// Expired on read: evict rather than leaving the entry to linger.
			this.entries.delete(key);
			return undefined;
		}
		// Refresh LRU recency without resetting the TTL clock.
		this.entries.delete(key);
		this.entries.set(key, hit);
		return hit.value;
	}

	set(key: K, value: V): void {
		this.entries.delete(key);
		this.entries.set(key, { at: this.now(), value });
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value as K | undefined;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
	}

	delete(key: K): void {
		this.entries.delete(key);
	}

	clear(): void {
		this.entries.clear();
	}

	get size(): number {
		return this.entries.size;
	}
}
