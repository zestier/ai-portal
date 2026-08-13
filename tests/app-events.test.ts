import { describe, it, expect, vi } from 'vitest';
import {
	getAppEventBus,
	publishAppEvent,
	startAppEventReaper,
	stopAppEventReaper,
	type AppEventBus,
	type IdentifiedAppEvent
} from '../src/lib/server/runtime/app-events';
import type { AppEvent } from '../src/lib/types';

function awaiting(conversationId: number, awaiting: boolean): AppEvent {
	return { type: 'awaiting.changed', conversationId: `C${conversationId}`, awaiting };
}

/**
 * Drain `count` events from a subscription, then abort. Rejects if `count`
 * events don't arrive within `timeoutMs` so a hung test fails fast instead of
 * waiting on the never-ending live queue.
 */
async function take(
	bus: AppEventBus,
	userId: number,
	count: number,
	opts: { sinceId?: string; timeoutMs?: number } = {},
	produce?: () => void
): Promise<IdentifiedAppEvent[]> {
	const ac = new AbortController();
	const out: IdentifiedAppEvent[] = [];
	const timeoutMs = opts.timeoutMs ?? 1000;
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	const iter = (async () => {
		for await (const ev of bus.subscribe(userId, {
			signal: ac.signal,
			...(opts.sinceId !== undefined ? { sinceId: opts.sinceId } : {})
		})) {
			out.push(ev);
			if (out.length >= count) {
				ac.abort();
				break;
			}
		}
	})();
	// Give the generator a microtask to register its live subscriber before we
	// publish, so live (non-replay) events aren't missed.
	await Promise.resolve();
	produce?.();
	await iter;
	clearTimeout(timer);
	return out;
}

describe('app event bus', () => {
	it('delivers live published events to a subscriber', async () => {
		const bus = getAppEventBus();
		const userId = Math.floor(Math.random() * 1e9);
		const got = await take(bus, userId, 2, {}, () => {
			bus.publish(userId, awaiting(1, true));
			bus.publish(userId, awaiting(2, true));
		});
		expect(got.map((e) => e.event)).toEqual([awaiting(1, true), awaiting(2, true)]);
		// Ids are monotonically-increasing ULID cursors.
		expect(typeof got[0].id).toBe('string');
		expect(got[1].id > got[0].id).toBe(true);
	});

	it('replays buffered events newer than Last-Event-ID on reconnect', async () => {
		const bus = getAppEventBus();
		const userId = Math.floor(Math.random() * 1e9);

		// Keep one subscriber open so the channel (and its replay buffer) isn't
		// GC'd, then publish three events and capture the first id from it.
		const keepAlive = new AbortController();
		const seen: IdentifiedAppEvent[] = [];
		const live = (async () => {
			for await (const ev of bus.subscribe(userId, { signal: keepAlive.signal })) {
				seen.push(ev);
			}
		})();
		await Promise.resolve();
		bus.publish(userId, awaiting(1, true));
		bus.publish(userId, awaiting(1, false));
		bus.publish(userId, awaiting(2, true));
		while (seen.length < 3) await new Promise((r) => setTimeout(r, 0));
		const firstId = seen[0].id;

		// Reconnect from the first id: only the two strictly-newer events replay.
		const got = await take(bus, userId, 2, { sinceId: firstId });
		expect(got.map((e) => e.event)).toEqual([awaiting(1, false), awaiting(2, true)]);
		expect(got.every((e) => e.id > firstId)).toBe(true);

		keepAlive.abort();
		await live;
	});

	it('replay then live is gap- and duplicate-free', async () => {
		const bus = getAppEventBus();
		const userId = Math.floor(Math.random() * 1e9);
		bus.publish(userId, awaiting(1, true)); // buffered

		const got = await take(bus, userId, 2, {}, () => {
			// Published after subscribe registered: arrives live, not via replay.
			bus.publish(userId, awaiting(1, false));
		});
		expect(got.map((e) => e.event)).toEqual([awaiting(1, true), awaiting(1, false)]);
		expect(got[1].id > got[0].id).toBe(true);
	});

	it('keeps live events flowing after an idle-GC reconnect with Last-Event-ID', async () => {
		const bus = getAppEventBus();
		const userId = Math.floor(Math.random() * 1e9);

		// First connection mints several ids, then fully disconnects so the idle
		// channel is GC'd — exactly what happens on a proxy/idle drop before the
		// browser auto-reconnects.
		const first = await take(bus, userId, 3, {}, () => {
			bus.publish(userId, awaiting(1, true));
			bus.publish(userId, awaiting(1, false));
			bus.publish(userId, awaiting(2, true));
		});
		const lastSeen = first[first.length - 1].id;

		// Reconnect carrying the last id the browser saw. ULIDs never rewind on
		// channel recreation, so the fresh event still out-ranks `lastSeen` and
		// is delivered (a per-user counter would have reset and dropped it).
		const resumed = await take(bus, userId, 1, { sinceId: lastSeen }, () => {
			bus.publish(userId, awaiting(3, true));
		});
		expect(resumed.map((e) => e.event)).toEqual([awaiting(3, true)]);
		expect(resumed[0].id > lastSeen).toBe(true);
	});

	it('isolates events per user', async () => {
		const bus = getAppEventBus();
		const a = 1001 + Math.floor(Math.random() * 1e6);
		const b = 2001 + Math.floor(Math.random() * 1e6);
		const got = await take(bus, a, 1, {}, () => {
			bus.publish(b, awaiting(9, true));
			bus.publish(a, awaiting(7, true));
		});
		expect(got.map((e) => e.event)).toEqual([awaiting(7, true)]);
	});

	it('publishAppEvent routes through the shared singleton bus', async () => {
		const bus = getAppEventBus();
		const userId = Math.floor(Math.random() * 1e9);
		const got = await take(bus, userId, 1, {}, () => {
			publishAppEvent(userId, awaiting(1, true));
		});
		expect(got.map((e) => e.event)).toEqual([awaiting(1, true)]);
	});

	it('reaps subscriber-less channels after the idle TTL (no unbounded growth)', async () => {
		const bus = getAppEventBus();
		const stale = 3001 + Math.floor(Math.random() * 1e6);
		const other = 4001 + Math.floor(Math.random() * 1e6);
		const base = Date.now();
		const nowSpy = vi.spyOn(Date, 'now');

		// A user publishes a transition while never connected -> buffered.
		nowSpy.mockReturnValue(base);
		bus.publish(stale, awaiting(1, true));

		// Within the TTL the buffer is still there: a (re)connect replays it.
		nowSpy.mockReturnValue(base + 60_000);
		const fresh = await take(bus, stale, 1, { sinceId: '' });
		expect(fresh.map((e) => e.event)).toEqual([awaiting(1, true)]);

		// Long past the TTL, any publish (here for a different user) sweeps the
		// idle channel. The stale user's buffer is gone: a later subscribe is a
		// fresh empty channel and replays nothing.
		nowSpy.mockReturnValue(base + 10 * 60_000);
		bus.publish(other, awaiting(9, true));

		const afterReap = await take(bus, stale, 1, { sinceId: '', timeoutMs: 150 }, () => {
			// Only a freshly-published live event should arrive — no replay of c1.
			bus.publish(stale, awaiting(2, false));
		});
		expect(afterReap.map((e) => e.event)).toEqual([awaiting(2, false)]);

		nowSpy.mockRestore();
	});

	it('reaps a subscriber-less channel past TTL on the next unrelated disconnect (no publish)', async () => {
		const bus = getAppEventBus();
		const stale = 3001 + Math.floor(Math.random() * 1e6);
		const other = 4001 + Math.floor(Math.random() * 1e6);
		const base = Date.now();
		const nowSpy = vi.spyOn(Date, 'now');

		// `stale` connects once and immediately disconnects -> a subscriber-less
		// channel sitting in the map, awaiting reaping. No publish ever follows.
		nowSpy.mockReturnValue(base);
		await take(bus, stale, 1, { timeoutMs: 50 }, () => {
			bus.publish(stale, awaiting(1, true));
		});

		// Long past the TTL, a *different* user merely connects and disconnects
		// with NO publish anywhere. The only thing that can reclaim the stale
		// channel is the new `subscribe` `finally` sweep (the pre-existing
		// publish-path reap never runs here).
		nowSpy.mockReturnValue(base + 10 * 60_000);
		await take(bus, other, 1, { timeoutMs: 50 });

		// Stale channel is gone: a later subscribe is a fresh empty channel and
		// replays nothing — only the freshly-published live event arrives.
		nowSpy.mockReturnValue(base + 10 * 60_000);
		const afterReap = await take(bus, stale, 1, { sinceId: '', timeoutMs: 150 }, () => {
			bus.publish(stale, awaiting(2, false));
		});
		expect(afterReap.map((e) => e.event)).toEqual([awaiting(2, false)]);

		nowSpy.mockRestore();
	});

	it('background reaper reclaims an idle channel with no publish or subscribe', async () => {
		vi.useFakeTimers();
		try {
			const bus = getAppEventBus();
			const stale = 3001 + Math.floor(Math.random() * 1e6);

			// Buffer an event for a never-connected user, then leave the process
			// idle: no further publish, no further subscribe.
			bus.publish(stale, awaiting(1, true));

			startAppEventReaper();
			// Advance past two sweeps: the interval period equals the TTL, so the
			// first tick (elapsed == TTL) doesn't reap (strict `>`); the second
			// (elapsed > TTL) does.
			vi.advanceTimersByTime(11 * 60_000);

			// The interval reclaimed the idle channel: a fresh subscribe replays
			// nothing (only the new live event arrives).
			const out: IdentifiedAppEvent[] = [];
			const ac = new AbortController();
			const iter = (async () => {
				for await (const ev of bus.subscribe(stale, { signal: ac.signal, sinceId: '' })) {
					out.push(ev);
					ac.abort();
					break;
				}
			})();
			await Promise.resolve();
			bus.publish(stale, awaiting(2, false));
			await iter;
			expect(out.map((e) => e.event)).toEqual([awaiting(2, false)]);
		} finally {
			stopAppEventReaper();
			vi.useRealTimers();
		}
	});
});
