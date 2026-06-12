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
	const existing = sessions.get(opts.conversationId);
	const requestedProvider = opts.provider ?? getDefaultProviderId();
	const requestedProviderSessionId = opts.providerSessionId ?? opts.conversationId;
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
		await disposeSession(existing.session, {
			conversationId: opts.conversationId,
			reason: 'session_mismatch'
		});
		sessions.delete(opts.conversationId);
	}
	// Coalesce concurrent acquires for the same conversation. Without
	// this, two callers can both miss the cache, both await open(), and
	// the loser's session is orphaned (its subprocess stays alive but
	// nothing references it).
	const pending = inflight.get(opts.conversationId);
	if (pending) return pending;
	const cfg = loadConfig();
	if (sessions.size >= cfg.MAX_CONCURRENT_SESSIONS) {
		// Evict to make room. Prefer the oldest session with NO work
		// outstanding so we never strand an open prompt / active turn. Only
		// if every session is busy do we force-evict the oldest one — and
		// then we expire its pending prompts with a distinct "session
		// expired — re-issue" outcome so the parked agent unblocks instead
		// of hanging on a deferred whose executor we just disposed.
		const sorted = [...sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
		const unprotected = sorted.find(([cid]) => !isProtected(cid));
		const [oldestId, oldest] = unprotected ?? sorted[0];
		if (unprotected) {
			log.info('copilot.pool.evict', { conversationId: oldestId });
		} else {
			log.warn('copilot.pool.evict_forced', { conversationId: oldestId });
			// Settle the parked deferreds BEFORE disposing so the resolved
			// event lands and the SDK callback's promise can't leak.
			expireConversation(oldestId, 'capacity_evict');
		}
		await disposeSession(oldest.session, {
			conversationId: oldestId,
			reason: unprotected ? 'capacity_evict' : 'capacity_evict_forced'
		});
		sessions.delete(oldestId);
	}
	const openPromise = open(opts).then(
		(session) => {
			sessions.set(opts.conversationId, { session, lastUsed: Date.now() });
			inflight.delete(opts.conversationId);
			return session;
		},
		(err) => {
			inflight.delete(opts.conversationId);
			throw err;
		}
	);
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
