// Pool of long-lived per-conversation sessions with idle reaping.

import { loadConfig } from '../config';
import {
	appGlobalSymbols,
	clearGlobalSingletonValues,
	getGlobalSingletonValue,
	getOrCreateGlobalSingleton,
	setGlobalSingletonValue
} from '../global-singleton';
import { hasPending, expireConversation } from './interactive-requests';
import { log } from '../log';
import {
	getDefaultProviderId,
	open,
	type ProviderOpenOptions,
	type ProviderSession
} from '../providers';

interface Entry {
	session: ProviderSession;
	lastUsed: number;
}

// Stash on globalThis so Vite HMR re-imports of this module in dev don't
// orphan the live SDK sessions in the old module's closure. See the
// matching comment in turn-runner.ts.
const SESSIONS_KEYS = appGlobalSymbols('pool.sessions');
const REAPER_KEYS = appGlobalSymbols('pool.reaper');
type SessionsMap = Map<string, Entry>;
type InflightMap = Map<string, Promise<ProviderSession>>;
const sessions: SessionsMap = getOrCreateGlobalSingleton(
	SESSIONS_KEYS,
	() => new Map<string, Entry>()
);
// In-flight `open()` promises, keyed by conversationId. Concurrent
// acquire() calls for the same conversation share one open(), avoiding
// the TOCTOU between `sessions.get` and `sessions.set` that would
// otherwise leak a second SDK subprocess.
const INFLIGHT_KEYS = appGlobalSymbols('pool.inflight');
const inflight: InflightMap = getOrCreateGlobalSingleton(
	INFLIGHT_KEYS,
	() => new Map<string, Promise<ProviderSession>>()
);
function getReaperTimer(): NodeJS.Timeout | null {
	return getGlobalSingletonValue<NodeJS.Timeout>(REAPER_KEYS);
}
function setReaperTimer(t: NodeJS.Timeout | null) {
	setGlobalSingletonValue(REAPER_KEYS, t);
}

// Keep-alive predicates: external signals that a conversation's session has
// work outstanding and must not be silently disposed by the idle reaper or
// capacity eviction. `interactive-requests` is consulted directly (see
// `isProtected`); the turn registry registers itself here to avoid an import
// cycle (turn-runner already imports this module). Keyed by a stable id so a
// Vite HMR re-import re-registering its predicate replaces rather than
// duplicates the entry. Stashed on globalThis for the same HMR reason as the
// session map.
type KeepAlivePredicate = (conversationId: string) => boolean;
const KEEPALIVE_KEYS = appGlobalSymbols('pool.keepAlive');
const keepAlive: Map<string, KeepAlivePredicate> = getOrCreateGlobalSingleton(
	KEEPALIVE_KEYS,
	() => new Map<string, KeepAlivePredicate>()
);

export function registerKeepAlive(id: string, fn: KeepAlivePredicate) {
	keepAlive.set(id, fn);
}

/**
 * True if the conversation's session has work outstanding (an open interactive
 * prompt or an active turn) and therefore must not be reaped/evicted silently.
 */
function isProtected(conversationId: string): boolean {
	if (hasPending(conversationId)) return true;
	for (const fn of keepAlive.values()) {
		try {
			if (fn(conversationId)) return true;
		} catch (err) {
			log.warn('copilot.pool.keepalive_predicate_failed', {
				conversationId,
				err: err instanceof Error ? err.message : String(err)
			});
		}
	}
	return false;
}

async function disposeSession(
	session: ProviderSession,
	context: { conversationId: string; reason: string }
): Promise<void> {
	try {
		await session.dispose();
	} catch (err) {
		log.warn('copilot.pool.dispose_failed', {
			...context,
			provider: session.provider,
			err: err instanceof Error ? (err.stack ?? err.message) : String(err)
		});
	}
}

export async function acquire(opts: ProviderOpenOptions): Promise<ProviderSession> {
	// Coalesce concurrent acquires for the same conversation. Checked
	// before the `existing` branch (and before any `await`) so two racing
	// acquires for the same conversation — including a pair that both see a
	// session mismatch — can't both dispose the cached session and both
	// open a fresh one. Without this, the loser's session is orphaned (its
	// subprocess stays alive but nothing references it).
	const pending = inflight.get(opts.conversationId);
	if (pending) return pending;

	const requestedProvider = opts.provider ?? getDefaultProviderId();
	const requestedProviderSessionId = opts.providerSessionId ?? opts.conversationId;

	// Sessions to tear down once the new open is in flight. Map mutations
	// (claiming the stale entry / eviction victim) happen synchronously
	// below so a concurrent acquire can never observe — and re-dispose —
	// something we've already claimed; the awaited disconnect runs inside
	// the coalesced open promise.
	const toDispose: Array<{
		session: ProviderSession;
		context: { conversationId: string; reason: string };
	}> = [];

	const existing = sessions.get(opts.conversationId);
	if (existing) {
		const cachedProvider = existing.session.provider ?? getDefaultProviderId();
		const cachedProviderSessionId =
			existing.session.providerSessionId ?? existing.session.conversationId;
		if (
			existing.session.workingDirectory === opts.workingDirectory &&
			existing.session.model === opts.model &&
			cachedProviderSessionId === requestedProviderSessionId &&
			cachedProvider === requestedProvider
		) {
			existing.lastUsed = Date.now();
			return existing.session;
		}
		log.warn('copilot.pool.session_mismatch_recreate', {
			conversationId: opts.conversationId,
			cachedProvider,
			requestedProvider,
			cachedWorkdir: existing.session.workingDirectory,
			requestedWorkdir: opts.workingDirectory,
			cachedModel: existing.session.model,
			requestedModel: opts.model,
			cachedProviderSessionId,
			requestedProviderSessionId
		});
		// Claim the stale entry synchronously, then dispose it inside the
		// coalesced open below.
		sessions.delete(opts.conversationId);
		toDispose.push({
			session: existing.session,
			context: { conversationId: opts.conversationId, reason: 'session_mismatch' }
		});
	}

	const cfg = loadConfig();
	// Count in-flight opens alongside live sessions: each pending open will
	// become a live session, so ignoring them lets N concurrent opens for N
	// new conversations all pass the guard and blow past the cap.
	if (sessions.size + inflight.size >= cfg.MAX_CONCURRENT_SESSIONS) {
		// Evict to make room. Prefer the oldest session with NO work
		// outstanding so we never strand an open prompt / active turn. Only
		// if every session is busy do we force-evict the oldest one — and
		// then we expire its pending prompts with a distinct "session
		// expired — re-issue" outcome so the parked agent unblocks instead
		// of hanging on a deferred whose executor we just disposed.
		const sorted = [...sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
		const unprotected = sorted.find(([cid]) => !isProtected(cid));
		const picked = unprotected ?? sorted[0];
		// `picked` can be undefined when every slot is consumed by in-flight
		// opens (nothing live left to evict); there's nothing we can do but
		// let this open proceed.
		if (picked) {
			const [oldestId, oldest] = picked;
			// Claim the victim synchronously so a concurrent eviction can't
			// pick the same oldest session and double-dispose it.
			sessions.delete(oldestId);
			if (unprotected) {
				log.info('copilot.pool.evict', { conversationId: oldestId });
			} else {
				log.warn('copilot.pool.evict_forced', { conversationId: oldestId });
				// Settle the parked deferreds BEFORE disposing so the resolved
				// event lands and the SDK callback's promise can't leak.
				expireConversation(oldestId, 'capacity_evict');
			}
			toDispose.push({
				session: oldest.session,
				context: {
					conversationId: oldestId,
					reason: unprotected ? 'capacity_evict' : 'capacity_evict_forced'
				}
			});
		}
	}

	const openPromise = (async () => {
		try {
			// Disconnect the claimed sessions before opening, preserving the
			// original ordering (stale session first, then eviction victim).
			for (const { session, context } of toDispose) {
				await disposeSession(session, context);
			}
			const session = await open(opts);
			sessions.set(opts.conversationId, { session, lastUsed: Date.now() });
			return session;
		} finally {
			inflight.delete(opts.conversationId);
		}
	})();
	inflight.set(opts.conversationId, openPromise);
	return openPromise;
}

/**
 * Return the live session for a conversation iff one is currently cached.
 * Used by the /session PATCH endpoint to push mode/approve-all changes to a
 * running SDK session without spinning a fresh one (which would require
 * an auth token, working directory, etc. the endpoint doesn't have at hand).
 */
export function getActive(conversationId: string): ProviderSession | null {
	return sessions.get(conversationId)?.session ?? null;
}

export function touch(conversationId: string) {
	const e = sessions.get(conversationId);
	if (e) e.lastUsed = Date.now();
}

export async function release(conversationId: string) {
	const e = sessions.get(conversationId);
	if (!e) return;
	sessions.delete(conversationId);
	await disposeSession(e.session, { conversationId, reason: 'release' });
}

export function startIdleReaper() {
	if (getReaperTimer()) return;
	const cfg = loadConfig();
	const idleMs = cfg.IDLE_TIMEOUT_MIN * 60_000;
	const timer = setInterval(async () => {
		const now = Date.now();
		for (const [id, entry] of sessions) {
			if (now - entry.lastUsed > idleMs) {
				// Never reap a session with work outstanding (an open prompt
				// or an active turn). A forgotten prompt pins its session
				// indefinitely — an accepted trade-off, mirroring the
				// deliberate DEFAULT_TIMEOUT_MS=0 ("a leak is better than a
				// silent deny"). Capacity pressure still has an escape hatch
				// via the forced eviction in `acquire`.
				if (isProtected(id)) {
					log.info('copilot.pool.reap_skip_busy', { conversationId: id });
					continue;
				}
				log.info('copilot.pool.reap', { conversationId: id });
				sessions.delete(id);
				await disposeSession(entry.session, { conversationId: id, reason: 'idle_reap' });
			}
		}
	}, 60_000);
	timer.unref?.();
	setReaperTimer(timer);
}

/** Snapshot of session-pool counters for observability. */
export function getPoolStats(): { active: number; inflight: number; max: number } {
	const cfg = loadConfig();
	return { active: sessions.size, inflight: inflight.size, max: cfg.MAX_CONCURRENT_SESSIONS };
}

export async function shutdown() {
	const timer = getReaperTimer();
	if (timer) {
		clearInterval(timer);
		clearGlobalSingletonValues(REAPER_KEYS);
	}
	// Wait for any in-flight open() calls to settle (then dispose them
	// like any other live session) so shutdown doesn't race a half-built
	// session into a zombie subprocess.
	const pending = [...inflight.values()];
	inflight.clear();
	const built = await Promise.allSettled(pending);
	for (const r of built) {
		if (r.status === 'fulfilled') {
			await disposeSession(r.value, {
				conversationId: r.value.conversationId,
				reason: 'shutdown_inflight'
			});
		}
	}
	const all = [...sessions.values()];
	sessions.clear();
	await Promise.all(
		all.map((e) =>
			disposeSession(e.session, { conversationId: e.session.conversationId, reason: 'shutdown' })
		)
	);
}
