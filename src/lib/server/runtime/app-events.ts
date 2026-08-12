// Per-user, cross-conversation live event bus.
//
// Where `turn-runner.ts` fans a single turn's `PortalEvent`s out to the
// subscribers of that one turn, this bus fans `AppEvent`s out to *every*
// connection a single user has open, regardless of which conversation (if
// any) they're looking at. It backs the global `GET /api/events` SSE feed
// the app shell subscribes to once.
//
// Shape mirrors the turn subscriber pattern: each event gets a monotonic
// (per-user) id and is kept in a small bounded replay buffer so a browser
// `EventSource` reconnect (carrying `Last-Event-ID`) resumes without a gap.
//
// SINGLE-INSTANCE ONLY. Subscribers and the publish call sites
// (`interactive-requests.ts`) live in the same process, exactly like the
// `pending` interactive map this feed is driven from. A publish on another
// process would not reach this process's subscribers. That's an accepted
// limitation (same caveat as the interactive registry); the {@link AppEventBus}
// interface is deliberately the only thing call sites depend on, so a future
// cross-process backend (e.g. Redis pub/sub) can be dropped in without touching
// emitters or the SSE route.

import { AsyncQueue } from './async-queue';
import {
	appGlobalSymbols,
	clearGlobalSingletonValues,
	getGlobalSingletonValue,
	getOrCreateGlobalSingleton,
	setGlobalSingletonValue
} from '../global-singleton';
import { ulid } from '../db/ids';
import type { AppEvent } from '$lib/types';

export interface IdentifiedAppEvent {
	/**
	 * Opaque, monotonically-increasing cursor used for the SSE `id:` line /
	 * `Last-Event-ID`. A ULID from a monotonic factory: lexicographically
	 * ordered by issue time and globally non-repeating, so — unlike a per-user
	 * counter — it never rewinds when an idle channel is GC'd and recreated
	 * mid-session. That makes reconnect resume "events strictly after this id"
	 * a plain string comparison with no bookkeeping.
	 */
	id: string;
	event: AppEvent;
}

export interface SubscribeAppEventsOptions {
	/** Abort to unsubscribe (e.g. the HTTP request was cancelled). */
	signal?: AbortSignal;
	/**
	 * Resume after this id (the last one the client received, from
	 * `Last-Event-ID`). Buffered events with a lexicographically greater id are
	 * replayed before live delivery begins. Omit to start live (with whatever
	 * is still buffered).
	 */
	sinceId?: string;
}

/**
 * The contract every consumer (the SSE route) and producer
 * (`interactive-requests.ts`) depends on. Kept minimal and backend-agnostic so
 * the in-process implementation below can later be swapped for a clustered one.
 */
export interface AppEventBus {
	publish(userId: number, event: AppEvent): void;
	subscribe(userId: number, opts?: SubscribeAppEventsOptions): AsyncIterable<IdentifiedAppEvent>;
}

// How many recent events to retain per user for reconnect replay. A handful is
// plenty: the feed carries sparse, coalesced signals (an awaiting transition,
// not a token stream), and any longer gap is reconciled by the next layout
// `load` anyway.
const REPLAY_LIMIT = 64;

// How long a subscriber-less channel is kept before it's reaped. Long enough to
// comfortably outlast a browser EventSource auto-reconnect (seconds) so the
// replay buffer can bridge the gap, short enough that a user who publishes a
// transition and never reconnects (closed tab, headless/API-driven flow)
// doesn't pin their channel + buffer for the process lifetime.
const IDLE_CHANNEL_TTL_MS = 5 * 60_000;

interface UserChannel {
	buffer: IdentifiedAppEvent[];
	subscribers: Set<AsyncQueue<IdentifiedAppEvent>>;
	/** Wall-clock of the last publish or (un)subscribe; drives idle reaping. */
	lastActivityAt: number;
}

class InProcessAppEventBus implements AppEventBus {
	private channels = new Map<number, UserChannel>();

	private channel(userId: number): UserChannel {
		let ch = this.channels.get(userId);
		if (!ch) {
			ch = { buffer: [], subscribers: new Set(), lastActivityAt: Date.now() };
			this.channels.set(userId, ch);
		}
		return ch;
	}

	// Drop channels that have no live subscribers and haven't seen activity
	// within the TTL. Driven from three cheap places: every `publish` (sparse),
	// every `subscribe` `finally` (the other path that leaves a subscriber-less
	// channel behind), and a low-frequency background sweep (so a mostly-idle
	// process with no further publishes still reclaims — see `startReaper`). The
	// channel count is small, so an O(channels) pass is negligible. A channel
	// that is idle *and* sees no further activity simply stops growing — memory
	// stays bounded either way.
	private reapIdle(now: number): void {
		for (const [userId, ch] of this.channels) {
			if (ch.subscribers.size === 0 && now - ch.lastActivityAt > IDLE_CHANNEL_TTL_MS) {
				this.channels.delete(userId);
			}
		}
	}

	// Background sweep so a subscriber-less channel is reclaimed even when no
	// further `publish` or `subscribe` ever follows the last disconnect (the
	// common case on a mostly-idle single-user portal, or the first user to
	// disconnect before any activity). Mirrors the pool / memory-maintenance
	// reaper: a single unref'd interval pinned on a global singleton so Vite HMR
	// re-imports and repeated boots don't stack timers. Idempotent.
	startReaper(): void {
		if (getGlobalSingletonValue<NodeJS.Timeout>(APP_EVENT_REAPER_KEYS)) return;
		const timer = setInterval(() => this.reapIdle(Date.now()), IDLE_CHANNEL_TTL_MS);
		timer.unref?.();
		setGlobalSingletonValue(APP_EVENT_REAPER_KEYS, timer);
	}

	publish(userId: number, event: AppEvent): void {
		const now = Date.now();
		this.reapIdle(now);
		const ch = this.channel(userId);
		ch.lastActivityAt = now;
		const identified: IdentifiedAppEvent = { id: ulid(), event };
		ch.buffer.push(identified);
		if (ch.buffer.length > REPLAY_LIMIT) ch.buffer.splice(0, ch.buffer.length - REPLAY_LIMIT);
		for (const q of ch.subscribers) q.push(identified);
	}

	async *subscribe(
		userId: number,
		opts: SubscribeAppEventsOptions = {}
	): AsyncIterable<IdentifiedAppEvent> {
		const { signal, sinceId } = opts;
		const ch = this.channel(userId);

		// Register for live delivery FIRST, then snapshot the replay buffer.
		// JS is single-threaded and there is no `await` between these two
		// synchronous steps, so no publish can slip in unobserved: anything
		// already buffered is in `replay`, anything after is queued in `q`.
		const q = new AsyncQueue<IdentifiedAppEvent>();
		ch.subscribers.add(q);

		// Lexicographic `>` is chronological order for monotonic ULIDs.
		const replay =
			sinceId === undefined ? ch.buffer.slice() : ch.buffer.filter((e) => e.id > sinceId);

		const onAbort = () => {
			ch.subscribers.delete(q);
			q.end();
		};
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener('abort', onAbort, { once: true });
		}

		try {
			for (const ev of replay) {
				if (signal?.aborted) return;
				yield ev;
			}
			// No replay/live de-dup needed: `q` was registered before the buffer
			// snapshot (synchronously, no await between), so live events are
			// strictly those published afterward — disjoint from `replay`.
			for await (const ev of q) {
				yield ev;
			}
		} finally {
			signal?.removeEventListener('abort', onAbort);
			ch.subscribers.delete(q);
			// Don't drop *this* channel immediately on disconnect: keeping it (and
			// its replay buffer) alive briefly is exactly what lets a browser
			// EventSource auto-reconnect replay the events it missed during the
			// blip. Just mark it idle (its fresh `lastActivityAt` spares it from
			// the sweep just below); the TTL reaper reclaims it later if the user
			// never comes back. A reconnect gap beyond the buffer/TTL is
			// reconciled by the next layout `load`.
			if (ch.subscribers.size === 0) ch.lastActivityAt = Date.now();
			// Co-located sweep: `subscribe`'s `finally` is — alongside `publish` —
			// the other path that leaves a subscriber-less channel behind, so
			// opportunistically reclaim any *other* channel already past its TTL.
			// This is what stops the leak when no publish ever follows the last
			// unsubscribe; the background `startReaper` interval is the backstop.
			this.reapIdle(Date.now());
		}
	}
}

// Stashed on globalThis (mirroring the interactive `pending` map and the turn
// registry) so a Vite SSR HMR re-import doesn't orphan live subscribers in the
// old module's closure.
const APP_EVENT_BUS_KEYS = appGlobalSymbols('app-events.bus');

// The background idle-sweep timer, pinned on its own global singleton so HMR
// re-imports / repeated boots don't stack intervals (same rationale as the bus).
const APP_EVENT_REAPER_KEYS = appGlobalSymbols('app-events.reaper');

function getInProcessAppEventBus(): InProcessAppEventBus {
	return getOrCreateGlobalSingleton(APP_EVENT_BUS_KEYS, () => new InProcessAppEventBus());
}

export function getAppEventBus(): AppEventBus {
	return getInProcessAppEventBus();
}

/**
 * Start the low-frequency background sweep that reclaims subscriber-less
 * channels even when no further `publish`/`subscribe` follows the last
 * disconnect. Idempotent and `.unref()`'d; call once at boot.
 */
export function startAppEventReaper(): void {
	getInProcessAppEventBus().startReaper();
}

/** Stop the background sweep (shutdown / test cleanup). */
export function stopAppEventReaper(): void {
	const timer = getGlobalSingletonValue<NodeJS.Timeout>(APP_EVENT_REAPER_KEYS);
	if (timer) {
		clearInterval(timer);
		clearGlobalSingletonValues(APP_EVENT_REAPER_KEYS);
	}
}

/** Convenience: publish an `AppEvent` to a user's global feed. */
export function publishAppEvent(userId: number, event: AppEvent): void {
	getAppEventBus().publish(userId, event);
}
